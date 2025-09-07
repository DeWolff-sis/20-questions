// server.js (versione 1.1) - integra timer 60s + espulsione dopo 3 timeout
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
    players: new Map(), // socketId -> { name, role, timeouts }
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
    chat: [],
    turnTimer: null // node timeout id
  });
}

io.on('connection', (socket) => {
  socket.on('rooms:list', () => socket.emit('rooms:update', listRooms()));

  socket.on('room:create', ({ code, name }) => {
    if (rooms.has(code)) return socket.emit('system:error', 'Codice stanza già esistente');
    createRoom(code);
    const room = rooms.get(code);
    room.players.set(socket.id, { name, role: 'thinker', timeouts: 0 });
    room.thinkerSocketId = socket.id;
    socket.join(code);

    pushLog(room, `👤 ${name} ha creato la stanza ed è il Pensatore`);
    io.to(code).emit('room:state', publicRoomState(room));
    io.emit('rooms:update', listRooms());
  });

  socket.on('room:join', ({ code, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('system:error', 'Stanza non trovata');

    room.players.set(socket.id, { name, role: 'guesser', timeouts: 0 });
    socket.join(code);

    // invio storico log e chat al nuovo giocatore
    socket.emit('log:history', room.logs);
    socket.emit('chat:history', room.chat);

    pushLog(room, `👋 ${name} è entrato nella stanza`);

    // se il round è già in corso, aggiungi in coda all'ordine dei turni (se non presente)
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
      // Pensatore esce → round finisce rivelando la parola
      clearTurnTimer(room);
      io.to(code).emit('round:ended', {
        message: 'Il Pensatore ha lasciato la stanza. Round terminato.',
        secretWord: room.secretWord,
        questions: room.questions,
        guesses: room.guesses,
        winnerId: null
      });
      rooms.delete(code);
    } else {
      // Rimuovi dal turno e regola turnIdx / turno corrente
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
    // reset timeouts for all players
    for (const [, p] of room.players) p.timeouts = 0;

    io.to(code).emit('round:started', { maxQuestions: room.maxQuestions, players: getPlayers(room) });
    io.to(room.thinkerSocketId).emit('round:secret', { secretWord: room.secretWord });

    if (room.turnOrder.length > 0) {
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      // start timer for the first asker
      startAskTimer(room);
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

    // reset asker's timeout counter
    const asker = room.players.get(socket.id);
    if (asker) asker.timeouts = 0;

    clearTurnTimer(room); // stop ask timer
    const q = { id: room.questions.length + 1, by: socket.id, text: String(text).trim(), answer: null };
    room.questions.push(q);
    room.lastQuestionId = q.id;
    io.to(code).emit('question:new', { ...q, byName: room.players.get(socket.id)?.name });

    // start thinker's answer timer
    startAnswerTimer(room);
  });

  socket.on('question:answer', ({ code, id, answer }) => {
    const room = rooms.get(code);
    if (!room || socket.id !== room.thinkerSocketId) return;
    const q = room.questions.find(x => x.id === id);
    if (!q || q.answer) return;

    clearTurnTimer(room); // stop answer timer
    // reset thinker's timeouts
    const thinker = room.players.get(socket.id);
    if (thinker) thinker.timeouts = 0;

    q.answer = answer;
    io.to(code).emit('question:update', q);
    if (answer !== 'Non so') {
      room.asked++;
      io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    }

    if (room.turnOrder.length > 0) {
      // advance to next player
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      // start timer for next ask
      startAskTimer(room);
    }
    if (room.asked >= room.maxQuestions && room.status === 'playing') startGuessPhase(code);
  });

  socket.on('guess:submit', ({ code, text }) => {
    const room = rooms.get(code);
    if (!room || (room.status !== 'playing' && room.status !== 'guessing')) return;
    const guess = String(text).trim();
    const correct = room.secretWord && guess.toLowerCase() === room.secretWord.toLowerCase();

    if (room.status === 'guessing' && room.guessAttempts) {
      if (socket.id === room.thinkerSocketId) return;
      if (room.guessAttempts[socket.id] == null) room.guessAttempts[socket.id] = 2;
      if (room.guessAttempts[socket.id] <= 0) return;

      room.guessAttempts[socket.id]--;
      pushLog(room,
        `${room.players.get(socket.id)?.name} ha tentato: "${guess}" ${correct ? '✅' : '❌'} — Tentativi rimasti: ${room.guessAttempts[socket.id]}`
      );
      const player = room.players.get(socket.id);
      if (player) player.timeouts = 0; // reset on action
      if (correct) return endRoundAndRotate(code, `${room.players.get(socket.id)?.name} ha indovinato!`, socket.id);
      const allOut = Object.values(room.guessAttempts).every(x => x <= 0);
      if (allOut) return endRoundAndRotate(code, 'Nessuno ha indovinato. Tentativi esauriti.', null);
      return;
    }

    // Playing-phase guess (early guess)
    const player = room.players.get(socket.id);
    if (player) player.timeouts = 0; // reset inactivity
    room.guesses.push({ by: socket.id, text: guess, correct });
    io.to(code).emit('guess:new', { by: socket.id, name: room.players.get(socket.id)?.name, text: guess, correct });
    if (correct) return endRoundAndRotate(code, `${room.players.get(socket.id)?.name} ha indovinato!`, socket.id);

    // incorrect guess during playing counts as a question used
    room.asked++;
    io.to(code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    if (room.asked >= room.maxQuestions) startGuessPhase(code);
    else {
      // advance turn
      if (room.turnOrder.length > 0) {
        room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
        const nextId = room.turnOrder[room.turnIdx];
        io.to(code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
        startAskTimer(room); // start ask timer for next player
      }
    }
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
        clearTurnTimer(room);
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

  // === Helpers (timer logic) ===

  function clearTurnTimer(room) {
    if (!room) return;
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  function startAskTimer(room) {
    clearTurnTimer(room);
    if (!room || room.status !== 'playing') return;
    if (!room.turnOrder || room.turnOrder.length === 0) return;
    // ensure turnIdx in bounds
    if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
    const currentId = room.turnOrder[room.turnIdx];
    // notify the player to start timer (client shows progress)
    io.to(currentId).emit('timer:start', { duration: 60000, type: 'ask' });
    // set server-side timeout handler
    room.turnTimer = setTimeout(() => {
      handleAskTimeout(room, currentId);
    }, 60000);
  }

  function handleAskTimeout(room, playerId) {
    // verify room still in playing and same current player
    if (!room || room.status !== 'playing') return;
    if (!room.turnOrder || room.turnOrder.length === 0) return;
    const current = room.turnOrder[room.turnIdx];
    if (current !== playerId) {
      // current changed since timer set -> ignore
      return;
    }
    const player = room.players.get(playerId);
    if (!player) {
      // player no longer present; remove from turnOrder
      handlePlayerExitDuringRound(room, playerId);
      return;
    }

    // increment timeout counter
    player.timeouts = (player.timeouts || 0) + 1;

    if (player.timeouts >= 3) {
      // expel player
      pushLog(room, `⛔ ${player.name} espulso per inattività (3 timeout).`);
      // remove from players and turnOrder
      handlePlayerExitDuringRound(room, playerId);
      io.to(room.code).emit('room:state', publicRoomState(room));
      io.emit('rooms:update', listRooms());
      // after removal, next turn is already managed by handlePlayerExitDuringRound (it emits turn:now)
      clearTurnTimer(room);
      return;
    }

    // otherwise, skip their turn, increment question count
    room.asked++;
    io.to(room.code).emit('counter:update', { asked: room.asked, max: room.maxQuestions });
    pushLog(room, `⏱ ${player.name} non ha fatto la domanda in tempo — turno saltato.`);

    // check if reached question limit
    if (room.asked >= room.maxQuestions) {
      clearTurnTimer(room);
      startGuessPhase(room.code);
      return;
    }

    // advance to next player and start their timer
    if (room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startAskTimer(room);
    } else {
      clearTurnTimer(room);
    }
  }

  function startAnswerTimer(room) {
    clearTurnTimer(room);
    if (!room || room.status !== 'playing') return;
    const thinkerId = room.thinkerSocketId;
    if (!thinkerId) return;
    io.to(thinkerId).emit('timer:start', { duration: 60000, type: 'answer' });
    room.turnTimer = setTimeout(() => {
      handleAnswerTimeout(room, thinkerId);
    }, 60000);
  }

  function handleAnswerTimeout(room, thinkerId) {
    if (!room || room.status !== 'playing') return;
    // find pending question (first with null answer)
    const q = room.questions.find(x => x.answer == null);
    if (q) {
      q.answer = 'Non so';
      io.to(room.code).emit('question:update', q);
      pushLog(room, `⏱ Il Pensatore non ha risposto in tempo → risposto automaticamente "Non so".`);
    }
    const thinker = room.players.get(thinkerId);
    if (thinker) {
      thinker.timeouts = (thinker.timeouts || 0) + 1;
      if (thinker.timeouts >= 3) {
        // expel thinker -> end round and reveal word (same as thinker leaving)
        clearTurnTimer(room);
        io.to(room.code).emit('round:ended', {
          message: 'Il Pensatore è stato espulso per inattività. Round terminato.',
          secretWord: room.secretWord,
          questions: room.questions,
          guesses: room.guesses,
          winnerId: null
        });
        rooms.delete(room.code);
        return;
      }
    }

    // proceed to next player's turn
    if (room.turnOrder.length > 0) {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      const nextId = room.turnOrder[room.turnIdx];
      io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
      startAskTimer(room);
    } else {
      clearTurnTimer(room);
    }
  }

  // === Other helpers (unchanged behavior from v1.0) ===
  function startGuessPhase(code) {
    const room = rooms.get(code);
    if (!room) return;
    room.status = 'guessing';
    room.guessAttempts = {};
    clearTurnTimer(room);
    for (const [id] of room.players) {
      if (id !== room.thinkerSocketId) room.guessAttempts[id] = 2;
    }
    pushLog(room, '🔔 Domande finite! Ogni giocatore ha 2 tentativi per indovinare.');
  }

  function endRoundAndRotate(code, message, winnerId = null) {
    const room = rooms.get(code);
    if (!room) return;
    clearTurnTimer(room);
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
      // ensure turnIdx valid
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
          clearTurnTimer(room);
          return;
        }
        // If the removed index is before current pointer, shift pointer left
        if (idx < room.turnIdx) {
          room.turnIdx = Math.max(0, room.turnIdx - 1);
        }
        // If the removed player was exactly the current turn index, then
        // the player that now occupies the same index is the next to play.
        if (idx === room.turnIdx) {
          if (room.turnIdx >= room.turnOrder.length) room.turnIdx = 0;
          const nextId = room.turnOrder[room.turnIdx];
          io.to(room.code).emit('turn:now', { socketId: nextId, name: room.players.get(nextId)?.name });
          // restart timer for the new current player
          startAskTimer(room);
        }
      }
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Server listening on http://localhost:' + PORT));
