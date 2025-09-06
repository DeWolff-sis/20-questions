const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = new Map();

function endRound(code, guesserId, reason) {
  const room = rooms.get(code);
  if (!room) return;

  const secretWord = room.secret;
  const guesser = guesserId || null;

  io.to(code).emit('round:ended', {
    message: reason,
    secretWord,
    guesser
  });

  room.status = 'waiting';
  room.secret = '';
  room.questions = [];
  room.awaitingAnswer = false;
  room.turnIdx = 0;
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, code }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    rooms.set(code, {
      code,
      players: new Map([[socket.id, { id: socket.id, name, role: 'thinker' }]]),
      thinkerSocketId: socket.id,
      secret: '',
      questions: [],
      maxQuestions: 20,
      awaitingAnswer: false,
      status: 'waiting',
      turnOrder: [],
      turnIdx: 0,
    });
    socket.join(code);
    socket.emit('room:joined', { code, role: 'thinker' });
    io.emit('rooms:update', Array.from(rooms.values()).map(r => ({
      code: r.code,
      count: r.players.size
    })));
  });

  socket.on('room:join', ({ name, code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');
    room.players.set(socket.id, { id: socket.id, name, role: 'guesser' });
    socket.join(code);
    io.to(code).emit('log', `${name} è entrato nella stanza.`);
    socket.emit('room:joined', { code, role: 'guesser' });
    io.emit('rooms:update', Array.from(rooms.values()).map(r => ({
      code: r.code,
      count: r.players.size
    })));
  });

  socket.on('room:leave', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) {
      io.to(code).emit('log', `${player.name} ha lasciato la stanza.`);
      room.players.delete(socket.id);
    }
    socket.leave(code);
    if (room.players.size === 0) rooms.delete(code);
    io.emit('rooms:update', Array.from(rooms.values()).map(r => ({
      code: r.code,
      count: r.players.size
    })));
  });

  socket.on('game:start', ({ code, secret }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    room.secret = secret;
    room.questions = [];
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
    room.turnIdx = 0;
    room.awaitingAnswer = false;
    room.status = 'playing';
    io.to(code).emit('game:started', { secretLen: secret.length });
    if (room.turnOrder.length > 0) {
      const first = room.turnOrder[0];
      io.to(code).emit('turn:now', { socketId: first, name: room.players.get(first)?.name });
    }
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const isTurn = room.turnOrder[room.turnIdx] === socket.id;
    if (!isTurn) return socket.emit('system:error', 'Non è il tuo turno');
    if (room.awaitingAnswer) return socket.emit('system:error', 'Attendi la risposta prima di fare un\'altra domanda');
    if (room.questions.length >= room.maxQuestions) {
      return socket.emit('system:error', 'Limite di domande raggiunto');
    }

    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    room.awaitingAnswer = true;
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q) return;
    q.answer = answer;
    io.to(code).emit('question:update', q);

    room.awaitingAnswer = false;

    if (answer !== 'Non so') {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }

    // ✅ Fine domande
    if (room.questions.length >= room.maxQuestions) {
      endRound(code, null, 'Domande esaurite. Nessuno ha indovinato.');
    }
  });

  socket.on('guess:try', ({ code, guess }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const correct = guess.toLowerCase().trim() === room.secret.toLowerCase().trim();
    if (correct) {
      endRound(code, socket.id, `${room.players.get(socket.id)?.name} ha indovinato!`);
    } else {
      io.to(code).emit('guess:wrong', { by: socket.id, name: room.players.get(socket.id)?.name, guess });
    }
  });

  socket.on('chat:send', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    io.to(code).emit('chat:new', { from: player.name, text });
  });

  socket.on('disconnect', () => {
    rooms.forEach((room, code) => {
      if (room.players.has(socket.id)) {
        const name = room.players.get(socket.id).name;
        room.players.delete(socket.id);
        io.to(code).emit('log', `${name} si è disconnesso.`);
        if (room.players.size === 0) rooms.delete(code);
      }
    });
    io.emit('rooms:update', Array.from(rooms.values()).map(r => ({
      code: r.code,
      count: r.players.size
    })));
  });
});

server.listen(3000, () => console.log('Server avviato su http://localhost:3000'));
