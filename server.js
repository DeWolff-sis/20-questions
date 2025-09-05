const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + '/public'));

let rooms = {};

function createRoom(code) {
  rooms[code] = {
    code,
    players: [],
    state: 'waiting',
    secretWord: null,
    maxQuestions: 20,
    asked: 0,
    turnIndex: 0,
    log: [],
    chat: [],
    attempts: {}, // tentativi extra per ciascun giocatore
  };
}

io.on('connection', (socket) => {
  console.log('Nuova connessione:', socket.id);

  socket.on('room:create', ({ code, name }) => {
    if (!rooms[code]) createRoom(code);
    const room = rooms[code];
    room.players.push({ id: socket.id, name, role: 'thinker' });
    socket.join(code);
    io.to(code).emit('room:state', room);
    io.emit('rooms:list', roomList());
    addLog(room, `👤 ${name} ha creato la stanza`);
    io.to(code).emit('log:bulk', room.log);
    io.to(code).emit('chat:bulk', room.chat);
  });

  socket.on('room:join', ({ code, name }) => {
    if (!rooms[code]) createRoom(code);
    const room = rooms[code];
    room.players.push({ id: socket.id, name, role: 'guesser' });
    socket.join(code);
    io.to(code).emit('room:state', room);
    io.emit('rooms:list', roomList());
    addLog(room, `👤 ${name} è entrato`);
    io.to(code).emit('log:bulk', room.log);
    io.to(code).emit('chat:bulk', room.chat);
  });

  socket.on('round:start', ({ code, secretWord }) => {
    const room = rooms[code];
    if (!room) return;
    room.state = 'playing';
    room.secretWord = secretWord;
    room.asked = 0;
    room.turnIndex = 0;
    room.attempts = {};
    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions });
    socket.emit('round:secret', { secretWord });
    addLog(room, `▶️ Round iniziato con parola segreta`);
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    room.asked++;
    const q = { id: room.asked, text, byId: socket.id, byName: getName(room, socket.id) };
    io.to(code).emit('question:new', q);
    io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms[code];
    if (!room) return;
    if (answer !== 'Non so') {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    }
    io.to(code).emit('question:update', { id, answer });
    if (room.asked >= room.maxQuestions) {
      startGuessPhase(room);
    }
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const name = getName(room, socket.id);
    const correct = text.toLowerCase() === room.secretWord.toLowerCase();
    io.to(code).emit('guess:new', { name, text, correct });
    if (correct) {
      endRound(room, `${name} ha indovinato!`, socket.id);
    } else {
      // decrementa tentativi se siamo in fase guess
      if (room.state === 'guessPhase') {
        room.attempts[socket.id] = (room.attempts[socket.id] || 2) - 1;
        addLog(room, `Tentativi rimasti per ${name}: ${room.attempts[socket.id]}`);
        io.to(code).emit('log:bulk', room.log);
        if (Object.values(room.attempts).every(v => v <= 0)) {
          endRound(room, 'Tutti i tentativi sono terminati', null);
        }
      } else {
        // in fase normale aumenta contatore
        room.asked++;
        io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
      }
    }
  });

  socket.on('chat:send', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const name = getName(room, socket.id);
    const msg = { name, text };
    room.chat.push(msg);
    io.to(code).emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        const [p] = room.players.splice(idx, 1);
        addLog(room, `🚪 ${p.name} ha lasciato la stanza`);
        io.to(code).emit('room:state', room);
        io.to(code).emit('log:bulk', room.log);
        io.emit('rooms:list', roomList());
      }
    }
  });
});

function endRound(room, message, guesserId) {
  const secretWord = room.secretWord;
  room.state = 'waiting';
  io.to(room.code).emit('round:ended', { message, secretWord, guesser: guesserId });
}

function startGuessPhase(room) {
  room.state = 'guessPhase';
  room.attempts = {};
  room.players.filter(p => p.role === 'guesser').forEach(p => {
    room.attempts[p.id] = 2;
  });
  addLog(room, '💡 Fase tentativi extra iniziata! Ogni giocatore ha 2 tentativi.');
  io.to(room.code).emit('log:bulk', room.log);
}

function addLog(room, msg) {
  room.log.push(msg);
}

function getName(room, id) {
  const p = room.players.find(p => p.id === id);
  return p ? p.name : '???';
}

function roomList() {
  return Object.values(rooms).map(r => ({
    code: r.code,
    players: r.players.length,
    status: r.state,
  }));
}

setInterval(() => {
  io.emit('rooms:list', roomList());
}, 3000);

server.listen(3000, () => {
  console.log('Server avviato su http://localhost:3000');
});
