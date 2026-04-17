const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();

// ─── Configuração do Banco de Dados (SQLite) ──────────────────────────────────
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('[DB] Erro ao abrir o banco:', err.message);
  else console.log('[DB] Conectado ao banco de dados SQLite.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    token TEXT PRIMARY KEY,
    name TEXT UNIQUE COLLATE NOCASE
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT,
    date TEXT,
    game_mode TEXT,
    score INTEGER,
    duration INTEGER,
    timestamp INTEGER
  )`);
});

// ─── Configuração do Servidor ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Banco de Perguntas ───────────────────────────────────────────────────────
function loadQuestions() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'questions.txt'), 'utf-8');
    const blocks = raw.split('---').map(b => b.trim()).filter(b => b.length > 0);
    return blocks.map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const theme = lines[0].replace(/^#\s*/, '').trim();
      const question = lines[1];
      const options = [lines[2], lines[3], lines[4], lines[5]];
      const correct = lines[6].toUpperCase(); // A, B, C ou D
      return { theme, question, options, correct };
    });
  } catch (err) {
    console.error('[ERRO] Arquivo questions.txt não encontrado ou inválido.');
    return [];
  }
}

let ALL_QUESTIONS = loadQuestions();

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Estado Global do Modo PvP ────────────────────────────────────────────────
let pvpState = {
  phase: 'lobby',      // lobby | countdown | question | gameover
  players: {},         // { token: { name, ws, score, answered, answeredCorrect, connected } }
  roundTime: 60,
  currentQuestion: null,
  questionIndex: 0,
  shuffledQuestions: [],
  timer: null,
  timeLeft: 0,
  countdownTimer: null,
  totalQuestions: 10,
};

let hostClient = null;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const HOST_IP = getLocalIP();
const PLAYER_URL = `http://${HOST_IP}:${PORT}/player.html`;

// ─── Utilitários PvP ──────────────────────────────────────────────────────────
function broadcastPvP(data) {
  const msg = JSON.stringify(data);
  Object.values(pvpState.players).forEach(p => {
    if (p.ws && p.connected && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  });
}

function sendToHost(data) {
  if (hostClient && hostClient.readyState === WebSocket.OPEN) {
    hostClient.send(JSON.stringify(data));
  }
}

function getPvPPlayersPublic() {
  return Object.entries(pvpState.players).map(([token, p]) => ({
    token, // We send token back so host knows IDs, but could be anonymized
    name: p.name,
    score: p.score,
    answered: p.answered,
    connected: p.connected
  }));
}

function broadcastPvPState() {
  const q = pvpState.currentQuestion;
  const payload = {
    type: 'pvp_state',
    phase: pvpState.phase,
    players: getPvPPlayersPublic(),
    roundTime: pvpState.roundTime,
    timeLeft: pvpState.timeLeft,
    questionIndex: pvpState.questionIndex,
    totalQuestions: pvpState.shuffledQuestions.length || pvpState.totalQuestions,
    question: q ? {
      theme: q.theme,
      text: q.question,
      options: q.options,
      // Nunca enviamos a correta antecipadamente (Regra 3 - Inteligência no Backend)
    } : null,
  };
  broadcastPvP(payload);
  sendToHost(payload);
}

// ─── Lógica PvP ───────────────────────────────────────────────────────────────
function checkAllPvPAnswered() {
  const playerTokens = Object.keys(pvpState.players);
  return playerTokens.length === 2 && playerTokens.every(t => pvpState.players[t].answered);
}

function startPvPCountdown() {
  pvpState.phase = 'countdown';
  let count = 10;
  broadcastPvPState();

  pvpState.countdownTimer = setInterval(() => {
    count--;
    broadcastPvP({ type: 'pvp_countdown', value: count });
    sendToHost({ type: 'pvp_countdown', value: count });
    if (count <= 0) {
      clearInterval(pvpState.countdownTimer);
      startPvPGame();
    }
  }, 1000);
}

function startPvPGame() {
  pvpState.shuffledQuestions = shuffle(ALL_QUESTIONS).slice(0, pvpState.totalQuestions);
  pvpState.questionIndex = 0;
  nextPvPQuestion();
}

function nextPvPQuestion() {
  if (pvpState.questionIndex >= pvpState.shuffledQuestions.length) {
    endPvPGame();
    return;
  }
  const q = pvpState.shuffledQuestions[pvpState.questionIndex];
  pvpState.currentQuestion = q;
  pvpState.phase = 'question';
  pvpState.timeLeft = pvpState.roundTime;

  Object.values(pvpState.players).forEach(p => {
    p.answered = false;
    p.answeredCorrect = null;
  });

  broadcastPvPState();
  
  if (pvpState.timer) clearInterval(pvpState.timer);
  pvpState.timer = setInterval(() => {
    pvpState.timeLeft--;
    broadcastPvP({ type: 'pvp_tick', timeLeft: pvpState.timeLeft });
    sendToHost({ type: 'pvp_tick', timeLeft: pvpState.timeLeft });

    if (pvpState.timeLeft <= 0) {
      clearInterval(pvpState.timer);
      // Tempo acabou, revela pro host e avança
      revealPvPAnswer();
    }
  }, 1000);
}

function revealPvPAnswer() {
  if (pvpState.timer) clearInterval(pvpState.timer);
  // O backend avisa o host qual era a certa para mostrar na tela
  sendToHost({ type: 'pvp_reveal', correct: pvpState.currentQuestion.correct });
  
  setTimeout(() => {
    pvpState.questionIndex++;
    nextPvPQuestion();
  }, 4000);
}

function endPvPGame() {
  pvpState.phase = 'gameover';
  broadcastPvPState();
  // Registrar pontuação no BD para cada jogador (Ranking global atualiza via PvP também)
  const today = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();
  Object.entries(pvpState.players).forEach(([token, p]) => {
    db.run(
      `INSERT INTO matches (token, date, game_mode, score, duration, timestamp) VALUES (?, ?, 'pvp', ?, ?, ?)`,
      [token, today, p.score, pvpState.roundTime * pvpState.totalQuestions, timestamp]
    );
  });
}

function resetPvPGame() {
  if (pvpState.timer) clearInterval(pvpState.timer);
  if (pvpState.countdownTimer) clearInterval(pvpState.countdownTimer);
  Object.values(pvpState.players).forEach(p => {
    p.score = 0;
    p.answered = false;
  });
  pvpState.phase = 'lobby';
  pvpState.currentQuestion = null;
  pvpState.questionIndex = 0;
  pvpState.shuffledQuestions = [];
  pvpState.timer = null;
  pvpState.timeLeft = 0;
  pvpState.countdownTimer = null;
  broadcastPvPState();
}

// ─── Estado do Modo Geral (Ranking) ───────────────────────────────────────────
// Gerencia as instâncias individuais de cada jogador
let rankingSessions = {}; // { ws_id: { token, ws, score, startTime, questions: [], qIndex, currentQ, timer, timeLeft } }

function startRankingSession(ws, token) {
  const totalTime = 60; // 60s fixo
  const questions = shuffle(ALL_QUESTIONS);
  
  const session = {
    token, ws, score: 0, startTime: Date.now(), 
    questions, qIndex: 0, currentQ: questions[0], 
    timeLeft: totalTime, timer: null
  };
  
  rankingSessions[token] = session;
  
  session.timer = setInterval(() => {
    session.timeLeft--;
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'ranking_tick', timeLeft: session.timeLeft }));
    }
    
    if (session.timeLeft <= 0) {
      clearInterval(session.timer);
      endRankingSession(token);
    }
  }, 1000);

  sendNextRankingQuestion(token);
}

function sendNextRankingQuestion(token) {
  const session = rankingSessions[token];
  if (!session) return;

  if (session.qIndex >= session.questions.length) {
    clearInterval(session.timer);
    endRankingSession(token);
    return;
  }

  session.currentQ = session.questions[session.qIndex];
  
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({
      type: 'ranking_question',
      question: {
        theme: session.currentQ.theme,
        text: session.currentQ.question,
        options: session.currentQ.options
        // Nunca envia a correta
      },
      score: session.score,
      qIndex: session.qIndex + 1
    }));
  }
}

function endRankingSession(token) {
  const session = rankingSessions[token];
  if (!session) return;

  const duration = Math.floor((Date.now() - session.startTime) / 1000);
  const today = new Date().toISOString().split('T')[0];
  const timestamp = Date.now();

  db.run(
    `INSERT INTO matches (token, date, game_mode, score, duration, timestamp) VALUES (?, ?, 'ranking', ?, ?, ?)`,
    [token, today, session.score, duration, timestamp],
    (err) => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'ranking_gameover', score: session.score }));
        sendTopRanking(session.ws);
      }
      delete rankingSessions[token];
    }
  );
}

function sendTopRanking(ws) {
  const query = `
    SELECT users.name, MAX(matches.score) as max_score, MIN(matches.duration) as min_duration 
    FROM matches 
    JOIN users ON matches.token = users.token 
    GROUP BY matches.token 
    ORDER BY max_score DESC, min_duration ASC 
    LIMIT 10
  `;
  db.all(query, [], (err, rows) => {
    if (err) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ranking_top10', ranking: rows }));
    }
  });
}

// ─── WebSocket Router ─────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log(`[WS] Novo cliente conectado`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // HOST ACTIONS
    if (msg.type === 'host_register') {
      hostClient = ws;
      ws._role = 'host';
      QRCode.toDataURL(PLAYER_URL, { width: 256, margin: 1 }, (err, url) => {
        sendToHost({ type: 'host_init', qrcode: err ? null : url, playerUrl: PLAYER_URL });
      });
      broadcastPvPState();
      return;
    }

    if (msg.type === 'set_time' && ws._role === 'host') {
      pvpState.roundTime = msg.time;
      broadcastPvPState();
      return;
    }

    if (msg.type === 'host_start' && ws._role === 'host') {
      if (Object.keys(pvpState.players).length === 2 && pvpState.phase === 'lobby') {
        startPvPCountdown();
      }
      return;
    }

    if (msg.type === 'host_reset' && ws._role === 'host') {
      resetPvPGame();
      return;
    }

    // REGISTRO DE USUÁRIO COMUM (Token, Names)
    if (msg.type === 'auth') {
      const name = (msg.name || '').trim().substring(0, 12);
      let token = msg.token;
      
      if (!name || name.length < 3) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Nome deve ter entre 3 e 12 caracteres.' }));
        return;
      }

      if (!token) token = uuidv4();

      db.get(`SELECT token, name FROM users WHERE token = ?`, [token], (err, row) => {
        if (row) {
          // Já existe, atualiza nome se necessário (ou mantém o existente)
          db.run(`UPDATE users SET name = ? WHERE token = ?`, [name, token]);
          ws.send(JSON.stringify({ type: 'auth_success', token, name }));
        } else {
          // Verifica se nome já está em uso por outro token
          db.get(`SELECT token FROM users WHERE name = ? COLLATE NOCASE`, [name], (err, row2) => {
            if (row2) {
              ws.send(JSON.stringify({ type: 'auth_error', message: 'Este nome já está em uso.' }));
            } else {
              db.run(`INSERT INTO users (token, name) VALUES (?, ?)`, [token, name], (err) => {
                ws.send(JSON.stringify({ type: 'auth_success', token, name }));
              });
            }
          });
        }
      });
      return;
    }

    // PVP PLAYER ACTIONS
    if (msg.type === 'pvp_join') {
      const { token, name } = msg;
      ws._role = 'pvp_player';
      ws._token = token;

      // Logica de Reconexão (Regra 5)
      if (pvpState.players[token]) {
        pvpState.players[token].ws = ws;
        pvpState.players[token].connected = true;
        ws.send(JSON.stringify({ type: 'pvp_accepted', name, reconnected: true }));
        broadcastPvPState();
        return;
      }

      if (Object.keys(pvpState.players).length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sala cheia! Máximo de 2 jogadores.' }));
        return;
      }
      if (pvpState.phase !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: 'Partida já iniciada!' }));
        return;
      }

      pvpState.players[token] = {
        name,
        ws,
        score: 0,
        answered: false,
        connected: true
      };
      
      ws.send(JSON.stringify({ type: 'pvp_accepted', name, reconnected: false }));
      broadcastPvPState();

      if (Object.keys(pvpState.players).length === 2) {
        sendToHost({ type: 'players_ready' });
      }
      return;
    }

    if (msg.type === 'pvp_answer' && ws._role === 'pvp_player') {
      const token = ws._token;
      const player = pvpState.players[token];
      if (!player || player.answered || pvpState.phase !== 'question') return;

      const answer = msg.answer;
      const correct = pvpState.currentQuestion.correct;
      const isCorrect = answer === correct;

      player.answered = true;
      player.answeredCorrect = isCorrect;
      if (isCorrect) player.score += 1; // 1 ponto por acerto

      ws.send(JSON.stringify({ type: 'pvp_answer_result', correct: isCorrect, score: player.score }));
      broadcastPvPState();

      if (checkAllPvPAnswered()) {
        setTimeout(revealPvPAnswer, 1200);
      }
      return;
    }

    // RANKING PLAYER ACTIONS
    if (msg.type === 'ranking_start') {
      const token = msg.token;
      ws._role = 'ranking_player';
      ws._token = token;
      
      const today = new Date().toISOString().split('T')[0];
      
      // Verifica limite diário (3 por dia)
      db.get(`SELECT COUNT(*) as count FROM matches WHERE token = ? AND date = ? AND game_mode = 'ranking'`, [token, today], (err, row) => {
        if (row && row.count >= 3) {
          ws.send(JSON.stringify({ type: 'error', message: 'Você atingiu o limite de 3 partidas de Ranking por dia.' }));
        } else {
          startRankingSession(ws, token);
        }
      });
      return;
    }

    if (msg.type === 'ranking_answer' && ws._role === 'ranking_player') {
      const token = ws._token;
      const session = rankingSessions[token];
      if (!session) return;

      const isCorrect = msg.answer === session.currentQ.correct;
      if (isCorrect) session.score += 1;

      ws.send(JSON.stringify({ type: 'ranking_answer_result', correct: isCorrect }));
      
      setTimeout(() => {
        session.qIndex++;
        sendNextRankingQuestion(token);
      }, 1500); // 1.5s de delay para ver o resultado antes da próxima
      return;
    }

    if (msg.type === 'ranking_get_top') {
      sendTopRanking(ws);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._role === 'host') {
      hostClient = null;
    } else if (ws._role === 'pvp_player') {
      const token = ws._token;
      if (pvpState.players[token]) {
        pvpState.players[token].connected = false;
        // Não removemos o jogador se a partida já começou ou está no lobby, para permitir reconexão
        broadcastPvPState();
      }
    } else if (ws._role === 'ranking_player') {
      const token = ws._token;
      if (rankingSessions[token]) {
        // Se desconectou, encerra a partida antecipadamente
        clearInterval(rankingSessions[token].timer);
        endRankingSession(token);
      }
    }
  });
});

// ─── API REST ─────────────────────────────────────────────────────────────────
app.get('/api/ranking', (req, res) => {
  const query = `
    SELECT users.name, MAX(matches.score) as max_score, MIN(matches.duration) as min_duration 
    FROM matches 
    JOIN users ON matches.token = users.token 
    WHERE matches.game_mode = 'ranking' OR matches.game_mode = 'pvp'
    GROUP BY matches.token 
    ORDER BY max_score DESC, min_duration ASC 
    LIMIT 10
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮 Adivinha rodando em:`);
  console.log(`   Host/PC:  http://localhost:${PORT}`);
  console.log(`   Mobile:   http://${HOST_IP}:${PORT}/player.html`);
});
