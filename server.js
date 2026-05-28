const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ───────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = '1011';
const QUESTION_DURATION = 20; // seconds
const ANSWER_SHOW_DURATION = 5; // seconds before next question

// ─── In-memory state ─────────────────────────────────────────────────────────
const games = {}; // gameCode -> Game object
const clients = {}; // ws -> { gameCode, playerId, playerName, isAdmin }

// ─── Game structure ───────────────────────────────────────────────────────────
function createGame(questions) {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const game = {
    code,
    id: uuidv4(),
    status: 'waiting', // waiting | question | answer | finished
    questions,
    currentQuestion: -1,
    players: {}, // playerId -> { name, answers: [], score, speed: [] }
    timer: null,
    timerStart: null,
    createdAt: Date.now(),
  };
  games[code] = game;
  return game;
}

function deleteGame(code) {
  const game = games[code];
  if (!game) return;
  if (game.timer) clearTimeout(game.timer);
  // Notify connected players
  broadcastToGame(code, { type: 'game_deleted', message: '遊戲已被主持人刪除' });
  delete games[code];
}

// ─── Broadcasting ─────────────────────────────────────────────────────────────
function broadcast(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcastToGame(gameCode, data, excludeWs = null) {
  Object.entries(clients).forEach(([, info]) => {
    if (info.gameCode === gameCode && info.ws !== excludeWs) {
      broadcast(info.ws, data);
    }
  });
}

function broadcastToAll(gameCode, data) {
  broadcastToGame(gameCode, data);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
function calcLeaderboard(game) {
  return Object.entries(game.players)
    .map(([id, p]) => {
      const totalQ = game.questions.length;
      const answeredQ = Math.min(game.currentQuestion + 1, totalQ);
      const correct = p.answers.filter((a, i) => {
        const q = game.questions[i];
        return q && a !== null && a === q.correct;
      }).length;
      const correctRate = answeredQ > 0 ? correct / answeredQ : 0;
      const avgSpeed = p.speed.length > 0
        ? p.speed.reduce((a, b) => a + b, 0) / p.speed.length
        : QUESTION_DURATION;
      return { id, name: p.name, correct, correctRate, avgSpeed, total: answeredQ };
    })
    .sort((a, b) => {
      if (b.correctRate !== a.correctRate) return b.correctRate - a.correctRate;
      return a.avgSpeed - b.avgSpeed;
    })
    .slice(0, 3)
    .map((p, i) => ({ rank: i + 1, ...p }));
}

function calcAnswerStats(game, questionIndex) {
  const q = game.questions[questionIndex];
  if (!q) return [];
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  Object.values(game.players).forEach(p => {
    const ans = p.answers[questionIndex];
    if (ans !== null && ans !== undefined && counts[ans] !== undefined) {
      counts[ans]++;
    }
  });
  return q.options.map((text, i) => {
    const key = ['A', 'B', 'C', 'D'][i];
    return { key, text, count: counts[key], isCorrect: key === q.correct };
  });
}

// ─── Game flow ────────────────────────────────────────────────────────────────
function startNextQuestion(gameCode) {
  const game = games[gameCode];
  if (!game) return;

  game.currentQuestion++;

  if (game.currentQuestion >= game.questions.length) {
    // Game over
    game.status = 'finished';
    const leaderboard = calcLeaderboard(game);
    broadcastToAll(gameCode, {
      type: 'game_finished',
      leaderboard,
      players: Object.values(game.players).map(p => ({ name: p.name })),
    });
    return;
  }

  const q = game.questions[game.currentQuestion];
  game.status = 'question';
  game.timerStart = Date.now();

  // Reset this question's answers
  Object.values(game.players).forEach(p => {
    if (p.answers.length <= game.currentQuestion) {
      p.answers.push(null);
      p.speed.push(QUESTION_DURATION);
    }
  });

  broadcastToAll(gameCode, {
    type: 'question_start',
    questionIndex: game.currentQuestion,
    total: game.questions.length,
    question: q.question,
    options: q.options,
    duration: QUESTION_DURATION,
  });

  if (game.timer) clearTimeout(game.timer);
  game.timer = setTimeout(() => showAnswer(gameCode), QUESTION_DURATION * 1000);
}

function showAnswer(gameCode) {
  const game = games[gameCode];
  if (!game) return;

  game.status = 'answer';
  const q = game.questions[game.currentQuestion];
  const stats = calcAnswerStats(game, game.currentQuestion);
  const leaderboard = calcLeaderboard(game);

  broadcastToAll(gameCode, {
    type: 'question_end',
    questionIndex: game.currentQuestion,
    correct: q.correct,
    correctText: q.options[['A','B','C','D'].indexOf(q.correct)],
    stats,
    leaderboard,
    isLast: game.currentQuestion >= game.questions.length - 1,
  });

  if (game.currentQuestion < game.questions.length - 1) {
    if (game.timer) clearTimeout(game.timer);
    game.timer = setTimeout(() => startNextQuestion(gameCode), ANSWER_SHOW_DURATION * 1000);
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: '密碼錯誤' });
  }
});

// Create game
app.post('/api/admin/games', (req, res) => {
  const { password, questions } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授權' });
  if (!questions || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: '請至少設定一題' });
  }
  const game = createGame(questions);
  res.json({ code: game.code, id: game.id });
});

// Delete game
app.delete('/api/admin/games/:code', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授權' });
  const { code } = req.params;
  if (!games[code]) return res.status(404).json({ error: '找不到遊戲' });
  deleteGame(code);
  res.json({ ok: true });
});

// List games
app.get('/api/admin/games', (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授權' });
  const list = Object.values(games).map(g => ({
    code: g.code,
    status: g.status,
    questionCount: g.questions.length,
    playerCount: Object.keys(g.players).length,
    createdAt: g.createdAt,
  }));
  res.json(list);
});

// Verify game code (for players)
app.get('/api/games/:code', (req, res) => {
  const game = games[req.params.code.toUpperCase()];
  if (!game) return res.status(404).json({ error: '找不到遊戲，請確認驗證碼' });
  res.json({
    code: game.code,
    status: game.status,
    questionCount: game.questions.length,
    playerCount: Object.keys(game.players).length,
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients[clientId] = { ws, gameCode: null, playerId: null, playerName: null, isAdmin: false };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients[clientId];

    switch (msg.type) {

      case 'admin_join': {
        if (msg.password !== ADMIN_PASSWORD) {
          broadcast(ws, { type: 'error', message: '密碼錯誤' });
          return;
        }
        client.isAdmin = true;
        client.gameCode = msg.gameCode;
        broadcast(ws, { type: 'admin_joined', gameCode: msg.gameCode });
        break;
      }

      case 'player_join': {
        const code = (msg.gameCode || '').toUpperCase();
        const game = games[code];
        if (!game) {
          broadcast(ws, { type: 'error', message: '找不到遊戲，請確認驗證碼' });
          return;
        }
        if (game.status !== 'waiting') {
          broadcast(ws, { type: 'error', message: '遊戲已經開始，無法加入' });
          return;
        }
        const playerId = uuidv4();
        const playerName = (msg.name || '匿名賓客').substring(0, 12);
        game.players[playerId] = { name: playerName, answers: [], speed: [] };
        client.gameCode = code;
        client.playerId = playerId;
        client.playerName = playerName;

        broadcast(ws, { type: 'joined', playerId, playerName, gameCode: code });
        // Notify all in game
        broadcastToAll(code, {
          type: 'player_count',
          count: Object.keys(game.players).length,
        });
        break;
      }

      case 'admin_start': {
        if (!client.isAdmin) return;
        const game = games[client.gameCode];
        if (!game || game.status !== 'waiting') return;
        startNextQuestion(client.gameCode);
        break;
      }

      case 'admin_next': {
        if (!client.isAdmin) return;
        const game = games[client.gameCode];
        if (!game || game.status !== 'answer') return;
        if (game.timer) clearTimeout(game.timer);
        startNextQuestion(client.gameCode);
        break;
      }

      case 'submit_answer': {
        const game = games[client.gameCode];
        if (!game || game.status !== 'question') return;
        const player = game.players[client.playerId];
        if (!player) return;
        const qi = game.currentQuestion;
        if (player.answers[qi] !== null && player.answers[qi] !== undefined) return; // already answered
        const elapsed = (Date.now() - game.timerStart) / 1000;
        player.answers[qi] = msg.answer;
        player.speed[qi] = elapsed;
        broadcast(ws, { type: 'answer_received', answer: msg.answer });
        break;
      }

      case 'admin_delete': {
        if (!client.isAdmin) return;
        if (msg.password !== ADMIN_PASSWORD) return;
        deleteGame(msg.gameCode);
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients[clientId];
    if (client && client.gameCode && client.playerId) {
      const game = games[client.gameCode];
      if (game && game.status === 'waiting') {
        delete game.players[client.playerId];
        broadcastToAll(client.gameCode, {
          type: 'player_count',
          count: Object.keys(game.players).length,
        });
      }
    }
    delete clients[clientId];
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 婚禮問答伺服器啟動：http://localhost:${PORT}`);
});
