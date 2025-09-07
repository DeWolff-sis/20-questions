const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname + "/public"));

const rooms = {};

function listRooms() {
  return Object.values(rooms).map(r => ({
    code: r.code,
    players: r.players.length,
    status: r.status
  }));
}

function getRoom(code) {
  return rooms[code];
}

function nextTurn(room) {
  clearTimeout(room.turnTimer);
  const players = room.players.filter(p => p.role !== "thinker");
  if (players.length === 0) return;

  room.turnIndex = (room.turnIndex + 1) % players.length;
  const current = players[room.turnIndex];
  io.to(room.code).emit("turn:now", { socketId: current.id, name: current.name });

  // start timer for asker
  startTurnTimer(room, current, "ask");
}

function startTurnTimer(room, player, type) {
  clearTimeout(room.turnTimer);
  const duration = 60000; // 60s
  io.to(player.id).emit("timer:start", { duration, type });

  room.turnTimer = setTimeout(() => {
    if (type === "ask") {
      player.timeouts++;
      if (player.timeouts >= 3) {
        // kick player
        room.players = room.players.filter(p => p.id !== player.id);
        io.to(player.id).emit("system:error", "Sei stato espulso per inattività.");
        io.sockets.sockets.get(player.id)?.leave(room.code);
        io.to(room.code).emit("log:message", `${player.name} è stato espulso per inattività.`);
      } else {
        room.asked++;
        io.to(room.code).emit("counter:update", { asked: room.asked, max: room.maxQuestions });
        io.to(room.code).emit("log:message", `${player.name} ha saltato il turno.`);
      }
      nextTurn(room);
    }
    if (type === "answer") {
      const q = room.questions.find(q => q.id === room.lastQuestionId);
      if (q && !q.answer) {
        q.answer = "Non so";
        io.to(room.code).emit("question:update", q);
        const thinker = room.players.find(p => p.role === "thinker");
        if (thinker) thinker.timeouts++;
        if (thinker && thinker.timeouts >= 3) {
          endRound(room, `Il pensatore è stato espulso per inattività.`, true);
          return;
        }
      }
      nextTurn(room);
    }
  }, duration);
}

function endRound(room, message, forceLose = false) {
  clearTimeout(room.turnTimer);
  room.status = "waiting";
  io.to(room.code).emit("round:ended", { message, secretWord: room.secretWord, forceLose });
}

io.on("connection", (socket) => {
  socket.on("rooms:list", () => socket.emit("rooms:update", listRooms()));

  socket.on("room:create", ({ code, name }) => {
    if (rooms[code]) {
      socket.emit("system:error", "Codice già in uso.");
      return;
    }
    const room = {
      code,
      players: [],
      status: "waiting",
      secretWord: null,
      asked: 0,
      maxQuestions: 20,
      turnIndex: -1,
      questions: [],
      lastQuestionId: null,
      turnTimer: null
    };
    rooms[code] = room;
    const thinker = { id: socket.id, name, role: "thinker", timeouts: 0 };
    room.players.push(thinker);
    socket.join(code);
    io.emit("rooms:update", listRooms());
    io.to(code).emit("room:state", room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = getRoom(code);
    if (!room) {
      socket.emit("system:error", "Stanza non trovata.");
      return;
    }
    const player = { id: socket.id, name, role: "player", timeouts: 0 };
    room.players.push(player);
    socket.join(code);
    io.to(code).emit("room:state", room);
    io.emit("rooms:update", listRooms());

    // se il round è in corso, inserisci il giocatore in coda
    if (room.status === "playing") {
      io.to(socket.id).emit("log:message", "Sei entrato: parteciperai al prossimo turno.");
    }
  });

  socket.on("room:leave", ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    if (player.role === "thinker") {
      endRound(room, "Il pensatore ha lasciato la partita.", true);
    } else {
      io.to(code).emit("log:message", `${player.name} ha lasciato la stanza.`);
      nextTurn(room);
    }
    io.to(code).emit("room:state", room);
    io.emit("rooms:update", listRooms());
  });

  socket.on("round:start", ({ code, secretWord }) => {
    const room = getRoom(code);
    if (!room) return;
    room.status = "playing";
    room.secretWord = secretWord;
    room.asked = 0;
    room.questions = [];
    room.turnIndex = -1;
    room.players.forEach(p => (p.timeouts = 0));
    io.to(code).emit("round:started", { maxQuestions: room.maxQuestions, players: room.players });
    const thinker = room.players.find(p => p.role === "thinker");
    if (thinker) io.to(thinker.id).emit("round:secret", { secretWord });
    nextTurn(room);
  });

  socket.on("question:ask", ({ code, text }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.timeouts = 0; // reset inactivity
    const q = { id: Date.now().toString(), text, by: player.id, byName: player.name, answer: null };
    room.questions.push(q);
    room.lastQuestionId = q.id;
    io.to(code).emit("question:new", q);

    // timer for thinker to answer
    const thinker = room.players.find(p => p.role === "thinker");
    if (thinker) startTurnTimer(room, thinker, "answer");
  });

  socket.on("question:answer", ({ code, id, answer }) => {
    const room = getRoom(code);
    if (!room) return;
    const q = room.questions.find(q => q.id === id);
    if (!q) return;
    q.answer = answer;
    const thinker = room.players.find(p => p.id === socket.id);
    if (thinker) thinker.timeouts = 0;
    io.to(code).emit("question:update", q);
    if (answer !== "Non so") {
      room.asked++;
      io.to(code).emit("counter:update", { asked: room.asked, max: room.maxQuestions });
    }
    if (room.asked >= room.maxQuestions) {
      endRound(room, "Domande terminate!", false);
    } else {
      nextTurn(room);
    }
  });

  socket.on("guess:submit", ({ code, text }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.timeouts = 0;
    const correct = room.secretWord && text.toLowerCase() === room.secretWord.toLowerCase();
    io.to(code).emit("guess:new", { name: player.name, text, correct });
    if (correct) {
      endRound(room, `${player.name} ha indovinato!`, false);
    } else {
      nextTurn(room);
    }
  });

  socket.on("disconnect", () => {
    Object.values(rooms).forEach(room => {
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      room.players = room.players.filter(p => p.id !== socket.id);
      if (player.role === "thinker") {
        endRound(room, "Il pensatore si è disconnesso.", true);
      } else {
        io.to(room.code).emit("log:message", `${player.name} si è disconnesso.`);
        nextTurn(room);
      }
      io.to(room.code).emit("room:state", room);
      io.emit("rooms:update", listRooms());
    });
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
