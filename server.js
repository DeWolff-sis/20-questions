// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();

function createRoom(code) {
  rooms.set(code, {
    code,
    status: 'waiting',
    players: new Map(), // socketId -> { name, role }
    thinkerSocketId: null,
    secretWord: null,
    questions: [],
    guesses: [],
    turnOrder: [], // array of socketIds (EXCLUDE thinker)
    turnIdx: 0,
    maxQuestions: 20,
    asked: 0,
    guessAttempts: null,
    logs: [],
    chat: []
  });
}

io.on('connection', (socket) => {
  socket.on('rooms:list', () => socket.emit('rooms:update', listRooms()));

  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    createRoom(code);
    const room = rooms.get(code);
    room.players.set(socket.id, { name, role: 'thinker' });
    room.thinkerSocketId = socket.id;
    socket.join(code);

    pushLog(room, `👤 ${name} ha creato la stanza ed è il Pensatore`);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');

    // add player
    room.players.set(socket.id, { name, role: 'guesser' });
    socket.join(code);

    // send histories to newcomer
    socket.emit('log:history', room.logs);
    socket.emit('chat:history', room.chat);

    pushLog(room, `👋 ${name} è entrato nella stanza`);

    // If a round is already in progress, append this player to the turnOrder (end of queue),
    // but only if it's not the thinker and not already present.
    if (room.status === 'playing') {
      if (socket.id !== room.thinkerSocketId && !room.turnOrder.includes(socket.id)) {
        room.turnOrder.push(socket.id);
        pushLog(room, `➕ ${name} si è unito in corsa e verrà servito quando arriverà il suo turno`);
      }
    }

    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  socket.on('room:leave', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    room.players.delete(socket.id);
    socket.leave(code);

    if (player) pushLog(room, `🚪 ${player.name} ha lasciato la stanza`);

    if (socket.id === room.thinkerSocketId) {
      // Pensatore esce -> round finisce e parola rivelata
      io.to(code).emit('round:ended', {
        message: 'Il Pensatore ha lasciato la stanza. Round terminato.',
        secretWord: room.secretWord,
        questions: room.questions,
        guesses: room.guesses,
        winnerId: null
      });
      rooms.delete(code);
    } else {
      // Remove player from turnOrder if present and adjust turnIdx
      handlePlayerExitDuringRound(room, socket.id);
      if (room.players.size === 0) {
        rooms.delete(code);
      } else {
        io.to(code).emit('room:state', publicRoomState(room));
      }
    }
    io.emit('rooms:update', listRooms());
  });

  // === ROUND START / GAMEPLAY EVENTS ===
  socket.on('round:start', ({ code, secretWord }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (socket.id !== room.thinkerSocketId) return;

    room.secretWord = String(secretWord || '').trim();
    if (!room.secretWord) return socket.emit('system:error', 'Parola segreta vuota');

    room.status = 'playing';
    room.questions = [];
    room.guesses = [];
    room.asked = 0;
    room.guessAttempts = null;

    // build fresh turnOrder from current players, excluding the thinker
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
    room.turnIdx = 0;

    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: getPlayers(room) });
    io.to(room.thinkerSocketId).emit('round:secret', { secretWord: room.secretWord });
    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }

    pushLog(room, '▶️ Round iniziato!');
    io.emit('rooms:update', listRooms());
    io.to(code).emit('room:state', publicRoomState(room));
  });

  socket.on('question:ask', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || room.status !== 'playing') return;
    const isTurn = room.turnOrder[room.turnIdx] === socket.id;
    if (!isTurn) return socket.emit('system:error', 'Non è il tuo turno');
    if (room.asked >= room.maxQuestions) return socket.emit('system:error', 'Limite domande raggiunto');

    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q || q.answer) return;
    q.answer = answer;

    io.to(code).emit('question:update', q);
    if (answer !== 'Non so') {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    }

    if (room.turnOrder.length > 0) {
      // advance to next index (wrap)
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
    }
    if (room.asked >= room.maxQuestions && room.status === 'playing') startGuessPhase(code);
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || (room.status !== 'playing' && room.status !== 'guessing')) return;
    const guess = String(text).trim();
    const correct = guess.toLowerCase() === (room.secretWord || '').toLowerCase();

    if (room.status === 'guessing' && room.guessAttempts) {
      if (socket.id === room.thinkerSocketId) return;
      if (room.guessAttempts[socket.id] == null) room.guessAttempts[socket.id] = 2;
      if (room.guessAttempts[socket.id] <= 0) return;

      room.guessAttempts[socket.id]--;
      pushLog(room,
        `${room.players.get(socket.id)?.name} ha tentato: "${guess}" ${correct ? '✅' : '❌'} — Tentativi rimasti: ${room.guessAttempts[socket.id]}`
      );
      if (correct) return endRoundAndRotate(code, `${room.players.get(socket.id)?.name} ha indovinato!`, socket.id);
      const allOut = Object.values(room.guessAttempts).every(x => x <= 0);
      if (allOut) return endRoundAndRotate(code, 'Nessuno ha indovinato. Tentativi esauriti.', null);
      return;
    }

    room.guesses.push({ by: socket.id, text: guess, correct });
    io.to(code).emit('guess:new', { by: socket.id, name: room.players.get(socket.id)?.name, text: guess, correct });
    if (correct) return endRoundAndRotate(code, `${room.players.get(socket.id)?.name} ha indovinato!`, socket.id);
    room.asked++;
    io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    if (room.asked >= room.maxQuestions) startGuessPhase(code);
  });

  socket.on('chat:message', ({ code, name, text }) => {
    const room = rooms.get(code);
    if (!room) return;
    const msg = { name, text };
    room.chat.push(msg);
    io.to(code).emit('chat:message', msg);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      if (!room.players.has(socket.id)) continue;
      const player = room.players.get(socket.id);
      room.players.delete(socket.id);
      if (player) pushLog(room, `🚪 ${player.name} si è disconnesso`);

      if (socket.id === room.thinkerSocketId) {
        io.to(code).emit('round:ended', {
          message: 'Il Pensatore ha lasciato la stanza. Round terminato.',
          secretWord: room.secretWord,
          questions: room.questions,
          guesses: room.guesses,
          winnerId: null
        });
        rooms.delete(code);
      } else {
        handlePlayerExitDuringRound(room, socket.id);
        io.to(code).emit('room:state', publicRoomState(room));
      }
    }
    io.emit('rooms:update', listRooms());
  });

  // === Helpers ===
  function startGuessPhase(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.status = 'guessing';
    room.guessAttempts = {};
    for (const [id] of room.players) {
      if (id !== room.thinkerSocketId) room.guessAttempts[id] = 2;
    }
    pushLog(room, '🔔 Domande finite! Ogni giocatore ha 2 tentativi per indovinare.');
  }

  function endRoundAndRotate(code, message, winnerId = null) {
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit('round:ended', {
      message,
      secretWord: room.secretWord,
      questions: room.questions,
      guesses: room.guesses,
      winnerId
    });
    rotateThinker(room);
    room.status = 'waiting';
    room.secretWord = null;
    room.questions = [];
    room.guesses = [];
    room.asked = 0;
    room.guessAttempts = null;
    pushLog(room, message);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  }

  function rotateThinker(room) {
    let nextThinkerId = null;
    if (room.turnOrder.length > 0) {
      // select the current turnIdx player as next thinker
      // ensure turnIdx within bounds
      if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
      nextThinkerId = room.turnOrder[room.turnIdx];
    } else {
      nextThinkerId = Array.from(room.players.keys()).find(id => id !== room.thinkerSocketId) || room.thinkerSocketId;
    }
    for (const [id, p] of room.players) {
      p.role = (id === nextThinkerId) ? 'thinker' : 'guesser';
    }
    room.thinkerSocketId = nextThinkerId;
    // rebuild turnOrder excluding new thinker
    room.turnOrder = Array.from(room.players.keys()).filter(id => id !== room.thinkerSocketId);
    room.turnIdx = 0;
  }

  function publicRoomState(room) {
    return { code: room.code, status: room.status, players: getPlayers(room), maxQuestions: room.maxQuestions };
  }
  function getPlayers(room) {
    return Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, role: p.role }));
  }
  function listRooms() {
    return Array.from(rooms.values()).map(r => ({ code: r.code, players: r.players.size, status: r.status }));
  }

  function pushLog(room, message) {
    room.logs.push(message);
    io.to(room.code).emit('log:message', message);
  }

  function handlePlayerExitDuringRound(room, socketId) {
    // Remove from turnOrder if present
    const idx = room.turnOrder.indexOf(socketId);
    if (idx !== -1) {
      room.turnOrder.splice(idx, 1);
      // If round is playing, adjust turnIdx and possibly emit next turn
      if (room.status === 'playing') {
        if (room.turnOrder.length === 0) {
          // no more guessers
          return;
        }
        // If the removed index is before current pointer, shift pointer left
        if (idx < room.turnIdx) {
          room.turnIdx = Math.max(0, room.turnIdx - 1);
        }
        // If the removed player was exactly the current turn index, then
        // the player that now occupies the same index is the next to play.
        if (idx === room.turnIdx) {
          // ensure turnIdx in bounds
          if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
          const nextId = room.turnOrder[room.turnIdx];
          io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
        }
      }
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));
