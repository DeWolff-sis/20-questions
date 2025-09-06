const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let rooms = {};

function listRooms() {
  return Object.values(rooms).map((r) => ({
    code: r.code,
    players: r.players.length,
    status: r.status,
  }));
}

function getNextPlayer(room) {
  if (!room.players.length) return null;
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
  return room.players[room.turnIndex];
}

io.on("connection", (socket) => {
  socket.on("rooms:list", () => {
    socket.emit("rooms:update", listRooms());
  });

  socket.on("room:create", ({ code, name }) => {
    if (rooms[code]) {
      socket.emit("system:error", "Codice stanza già in uso.");
      return;
    }
    rooms[code] = {
      code,
      players: [{ id: socket.id, name, role: "thinker" }],
      status: "waiting",
      maxQuestions: 20,
      asked: 0,
      secretWord: null,
      log: [],
      chat: [],
      turnIndex: -1,
    };
    socket.join(code);
    io.emit("rooms:update", listRooms());
    io.to(code).emit("room:state", rooms[code]);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms[code];
    if (!room) return;
    const newPlayer = { id: socket.id, name, role: "guesser" };
    room.players.push(newPlayer);
    socket.join(code);

    // Se round già iniziato, aggiungilo in coda alla rotazione
    if (room.status === "playing") {
      // Inseriamo dopo l'ultimo turno
      // Non cambiamo turnIndex, quindi sarà servito alla prossima rotazione
    }

    io.emit("rooms:update", listRooms());
    io.to(code).emit("room:state", room);
    socket.emit("chat:history", room.chat);
    socket.emit("log:history", room.log);
  });

  socket.on("room:leave", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return;
    const [removed] = room.players.splice(idx, 1);

    socket.leave(code);

    if (removed.role === "thinker") {
      io.to(code).emit("round:ended", {
        message: "Il Pensatore ha lasciato la stanza.",
        secretWord: room.secretWord,
      });
      room.status = "waiting";
      room.secretWord = null;
      room.asked = 0;
    } else {
      // Se round in corso e il giocatore era prima del turno attuale, sistemiamo l'indice
      if (room.status === "playing") {
        if (idx <= room.turnIndex) {
          room.turnIndex -= 1;
        }
        const next = getNextPlayer(room);
        if (next) io.to(code).emit("turn:now", next);
      }
    }

    if (room.players.length === 0) delete rooms[code];
    io.emit("rooms:update", listRooms());
    io.to(code).emit("room:state", room);
  });

  socket.on("round:start", ({ code, secretWord }) => {
    const room = rooms[code];
    if (!room) return;
    room.status = "playing";
    room.secretWord = secretWord;
    room.asked = 0;
    room.turnIndex = -1;

    io.to(code).emit("round:started", { maxQuestions: room.maxQuestions, players: room.players });
    const thinker = room.players.find((p) => p.role === "thinker");
    if (thinker) io.to(thinker.id).emit("round:secret", { secretWord });

    const next = getNextPlayer(room);
    if (next) io.to(code).emit("turn:now", next);
  });

  socket.on("question:ask", ({ code, text }) => {
    const room = rooms[code];
    if (!room || room.status !== "playing") return;
    room.asked++;
    const q = { id: Date.now(), by: socket.id, byName: room.players.find(p=>p.id===socket.id)?.name, text, answer: null };
    room.lastQuestion = q;
    io.to(code).emit("question:new", q);
    io.to(code).emit("counter:update", { asked: room.asked, max: room.maxQuestions });
  });

  socket.on("question:answer", ({ code, id, answer }) => {
    const room = rooms[code];
    if (!room || !room.lastQuestion || room.lastQuestion.id !== id) return;
    room.lastQuestion.answer = answer;
    io.to(code).emit("question:update", room.lastQuestion);
    const next = getNextPlayer(room);
    if (next) io.to(code).emit("turn:now", next);
    if (room.asked >= room.maxQuestions) {
      io.to(code).emit("round:ended", { message: "Nessuno ha indovinato.", secretWord: room.secretWord });
      room.status = "waiting";
      room.secretWord = null;
    }
  });

  socket.on("guess:submit", ({ code, text }) => {
    const room = rooms[code];
    if (!room || room.status !== "playing") return;
    const correct = text.toLowerCase() === room.secretWord.toLowerCase();
    io.to(code).emit("guess:new", { name: room.players.find(p=>p.id===socket.id)?.name, text, correct });
    if (correct) {
      io.to(code).emit("round:ended", { message: "Qualcuno ha indovinato!", secretWord: room.secretWord, winnerId: socket.id });
      room.status = "waiting";
      room.secretWord = null;
    } else {
      const next = getNextPlayer(room);
      if (next) io.to(code).emit("turn:now", next);
    }
  });

  socket.on("chat:message", ({ code, name, text }) => {
    const room = rooms[code];
    if (!room) return;
    const msg = { name, text };
    room.chat.push(msg);
    io.to(code).emit("chat:message", msg);
  });

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const [removed] = room.players.splice(idx, 1);
        if (removed.role === "thinker") {
          io.to(code).emit("round:ended", {
            message: "Il Pensatore ha lasciato la stanza.",
            secretWord: room.secretWord,
          });
          room.status = "waiting";
          room.secretWord = null;
          room.asked = 0;
        } else {
          if (room.status === "playing") {
            if (idx <= room.turnIndex) {
              room.turnIndex -= 1;
            }
            const next = getNextPlayer(room);
            if (next) io.to(code).emit("turn:now", next);
          }
        }
        if (room.players.length === 0) delete rooms[code];
        io.emit("rooms:update", listRooms());
        io.to(code).emit("room:state", room);
      }
    }
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));
