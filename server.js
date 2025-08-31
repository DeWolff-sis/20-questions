const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function newRoom(code) {
  return {
    code,
    players: new Map(),
    thinkerId: null,
    secretWord: null,
    questions: [],
    maxQuestions: 20,
    status: 'waiting',
    turnOrder: [],
    turnIdx: 0,
  };
}

io.on('connection', (socket) => {
  console.log('Nuovo client connesso', socket.id);

  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    const room = newRoom(code);
    rooms.set(code, room);
    joinRoom(socket, room, name);
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');
    joinRoom(socket, room, name);
  });

  socket.on('role:choose', ({ code, role }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.role = role;
    if (role === 'thinker') room.thinkerId = socket.id;
    io.to(code).emit('players:update', Array.from(room.players.values()));
  });

  socket.on('round:start', ({ code, secretWord }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.thinkerId !== socket.id) return;
    room.secretWord = secretWord;
    room.questions = [];
    room.status = 'playing';
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerId);
    room.turnIdx = 0;
    io.to(code).emit('round:begin');
    io.to(room.thinkerId).emit('round:secret', { secretWord });
    if (room.turnOrder.length > 1) {
      io.to(code).emit('turn:mode', { mode: 'free' });
    } else if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const numGuessers = Array.from(room.players.values()).filter(p => p.role === 'guesser').length;
    const freeMode = numGuessers >= 2;
    if (!freeMode) {
      const isTurn = room.turnOrder[room.turnIdx] === socket.id;
      if (!isTurn) return socket.emit('system:error', 'Non è il tuo turno');
    }
    if (room.questions.length >= room.maxQuestions) {
      return socket.emit('system:error', 'Limite di 20 domande raggiunto');
    }
    const q = { id: room.questions.length + 1, by: socket.id, text, answer: null };
    room.questions.push(q);
    io.to(room.thinkerId).emit('question:new', q);
    io.to(code).emit('log', `${room.players.get(socket.id)?.name} ha chiesto: ${text}`);
  });

  socket.on('question:answer', ({ code, qid, answer }) => {
    const room = rooms.get(code);
    if (!room || room.thinkerId !== socket.id) return;
    const q = room.questions.find(x => x.id === qid);
    if (!q) return;
    q.answer = answer;
    io.to(code).emit('question:update', q);
    io.to(code).emit('log', `Pensatore ha risposto: ${answer}`);
    const numGuessers = Array.from(room.players.values()).filter(p => p.role === 'guesser').length;
    const freeMode = numGuessers >= 2;
    if (!freeMode && room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    if (room.questions.length >= room.maxQuestions) {
      return socket.emit('system:error', 'Limite di 20 domande raggiunto');
    }
    const guess = String(text).trim();
    const correct = guess.toLowerCase() === room.secretWord.toLowerCase();
    const qEntry = {
      id: room.questions.length + 1,
      by: socket.id,
      text: `[Tentativo] ${guess}`,
      answer: correct ? '✅' : '❌',
      type: 'guess'
    };
    room.questions.push(qEntry);
    io.to(code).emit('guess:new', {
      by: socket.id,
      name: room.players.get(socket.id)?.name,
      text: guess,
      correct,
      qCount: room.questions.length
    });
    if (correct) endRound(code, true, `${room.players.get(socket.id)?.name} ha indovinato!`);
    if (!correct && room.questions.length >= room.maxQuestions) {
      endRound(code, false, 'Domande esaurite. Nessuno ha indovinato.');
    }
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        io.to(code).emit('players:update', Array.from(room.players.values()));
      }
    }
  });
});

function joinRoom(socket, room, name) {
  socket.join(room.code);
  room.players.set(socket.id, { id: socket.id, name, role: 'guesser' });
  io.to(room.code).emit('players:update', Array.from(room.players.values()));
}

function endRound(code, success, msg) {
  const room = rooms.get(code);
  if (!room) return;
  room.status = 'waiting';
  io.to(code).emit('round:end', { success, msg });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log("Server avviato sulla porta " + PORT);
}).on('error', (err) => {
  console.error("Errore nell'avvio del server:", err);
});
