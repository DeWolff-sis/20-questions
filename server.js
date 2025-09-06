const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + '/public'));

let rooms = {};

function getActiveRooms() {
  return Object.values(rooms).map(r => ({
    code: r.code,
    players: r.players.length
  }));
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ code, name }) => {
    if (!rooms[code]) {
      rooms[code] = {
        code,
        players: [],
        log: [],
        chat: [],
        secretWord: null,
        currentTurn: 0,
        questionCount: 0,
        maxQuestions: 20,
        roundActive: false,
        finalGuesses: {},
        thinkerIndex: 0
      };
    }
    const player = { id: socket.id, name, role: 'thinker' };
    rooms[code].players.push(player);
    socket.join(code);
    io.to(code).emit('room:state', rooms[code]);
    io.emit('rooms:list', getActiveRooms());
    addLog(code, `👤 ${name} è entrato (Pensatore)`);
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('system:error', 'Stanza non trovata');
      return;
    }
    const player = { id: socket.id, name, role: 'guesser' };
    room.players.push(player);
    socket.join(code);
    socket.emit('room:state', room);
    socket.emit('log:history', room.log);
    socket.emit('chat:history', room.chat);
    io.to(code).emit('room:state', room);
    io.emit('rooms:list', getActiveRooms());
    addLog(code, `👤 ${name} è entrato`);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const [player] = room.players.splice(idx, 1);
        addLog(code, `👋 ${player.name} ha lasciato`);
        io.to(code).emit('room:state', room);
        if (room.players.length === 0) delete rooms[code];
        io.emit('rooms:list', getActiveRooms());
      }
    }
  });

  socket.on('round:start', ({ code, secretWord }) => {
    const room = rooms[code];
    if (!room) return;
    room.secretWord = secretWord;
    room.roundActive = true;
    room.questionCount = 0;
    room.finalGuesses = {};
    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: room.players });
    const thinker = room.players.find(p => p.role === 'thinker');
    io.to(thinker.id).emit('round:secret', { secretWord });
    nextTurn(code);
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms[code];
    if (!room || !room.roundActive) return;
    room.questionCount++;
    const q = { id: room.questionCount, byId: socket.id, byName: getPlayerName(room, socket.id), text };
    io.to(code).emit('question:new', q);
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms[code];
    if (!room) return;
    if (answer !== 'Non so') {
      // domanda valida
    } else {
      room.questionCount--; // Non so non conta
    }
    io.to(code).emit('question:update', { id, answer });
    if (room.questionCount >= room.maxQuestions) {
      addLog(code, '⚠️ Limite domande raggiunto, iniziano i tentativi finali!');
      room.players.forEach(p => {
        if (p.role !== 'thinker') room.finalGuesses[p.id] = 2;
      });
    } else {
      nextTurn(code);
    }
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms[code];
    if (!room || !room.roundActive) return;
    room.questionCount++;
    const player = getPlayer(room, socket.id);
    const correct = (text.toLowerCase() === room.secretWord.toLowerCase());

    io.to(code).emit('guess:new', { id: socket.id, name: player.name, text, correct });

    if (correct) {
      endRound(code, `${player.name} ha indovinato!`, socket.id);
    } else {
      if (room.finalGuesses[player.id] !== undefined) {
        room.finalGuesses[player.id]--;
        addLog(code, `❌ ${player.name} ha sbagliato. Tentativi rimasti: ${room.finalGuesses[player.id]}`);
        if (room.finalGuesses[player.id] <= 0) delete room.finalGuesses[player.id];
        if (Object.keys(room.finalGuesses).length === 0) {
          endRound(code, 'Nessuno ha indovinato!', null);
        }
      }
      nextTurn(code);
    }
  });

  socket.on('chat:send', ({ code, name, text }) => {
    const room = rooms[code];
    if (!room) return;
    const msg = { name, text };
    room.chat.push(msg);
    io.to(code).emit('chat:new', msg);
  });
});

function nextTurn(code) {
  const room = rooms[code];
  if (!room) return;
  const guessers = room.players.filter(p => p.role !== 'thinker');
  if (guessers.length === 0) return;
  room.currentTurn = (room.currentTurn + 1) % guessers.length;
  const now = guessers[room.currentTurn];
  io.to(code).emit('turn:now', { socketId: now.id, name: now.name });
}

function endRound(code, message, guesserId) {
  const room = rooms[code];
  if (!room) return;
  room.roundActive = false;
  io.to(code).emit('round:ended', { message, secretWord: room.secretWord, guesser: guesserId });
  // ruota pensatore
  room.thinkerIndex = (room.thinkerIndex + 1) % room.players.length;
  room.players.forEach((p, i) => p.role = (i === room.thinkerIndex ? 'thinker' : 'guesser'));
}

function addLog(code, msg) {
  const room = rooms[code];
  if (!room) return;
  room.log.push(msg);
  io.to(code).emit('log:new', msg);
}

function getPlayer(room, id) {
  return room.players.find(p => p.id === id);
}
function getPlayerName(room, id) {
  const p = getPlayer(room, id);
  return p ? p.name : '??';
}

server.listen(3000, () => console.log('Server running on http://localhost:3000'));
