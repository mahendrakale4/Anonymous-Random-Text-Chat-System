const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] },
});

// --------------- In-memory data structures ---------------

let waitingQueue = []; // array of socket IDs waiting for a partner
const activeChats = new Map(); // socketId -> partnerSocketId
const rateLimitMap = new Map(); // socketId -> { timestamps: number[] }
const userNames = new Map(); // socketId -> display name

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 5;
const MAX_MESSAGE_LENGTH = 300;

// --------------- Helpers ---------------

function removeFromQueue(socketId) {
  waitingQueue = waitingQueue.filter((id) => id !== socketId);
}

function checkRateLimit(socketId) {
  const now = Date.now();
  let entry = rateLimitMap.get(socketId);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(socketId, entry);
  }
  entry.timestamps = entry.timestamps.filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (entry.timestamps.length >= RATE_LIMIT_MAX) return false;
  entry.timestamps.push(now);
  return true;
}

function endChat(socketId) {
  const partnerId = activeChats.get(socketId);
  if (partnerId) {
    activeChats.delete(socketId);
    activeChats.delete(partnerId);
  }
  return partnerId;
}

function tryMatch(socketId) {
  removeFromQueue(socketId);

  if (activeChats.has(socketId)) return;

  if (waitingQueue.length > 0) {
    const partnerId = waitingQueue.shift();

    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) {
      tryMatch(socketId);
      return;
    }

    activeChats.set(socketId, partnerId);
    activeChats.set(partnerId, socketId);

    const roomId = uuidv4();
    const nameA = userNames.get(socketId) || "Stranger";
    const nameB = userNames.get(partnerId) || "Stranger";
    io.to(socketId).emit("matched", { roomId, partnerName: nameB });
    io.to(partnerId).emit("matched", { roomId, partnerName: nameA });
  } else {
    waitingQueue.push(socketId);
  }
}

function broadcastStatus() {
  const pairs = [];
  const seen = new Set();
  for (const [idA, idB] of activeChats.entries()) {
    if (seen.has(idA)) continue;
    seen.add(idA);
    seen.add(idB);
    pairs.push({
      user1: userNames.get(idA) || "Stranger",
      user2: userNames.get(idB) || "Stranger",
    });
  }

  const searching = waitingQueue.map(
    (id) => userNames.get(id) || "Stranger"
  );

  io.emit("lobby_status", { pairs, searching });
}

// --------------- Socket.IO ---------------

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);
  broadcastStatus();

  socket.on("start_search", (data) => {
    if (activeChats.has(socket.id)) return;
    const name =
      typeof data === "object" && typeof data?.name === "string"
        ? data.name.trim().slice(0, 30)
        : "";
    if (name) userNames.set(socket.id, name);
    removeFromQueue(socket.id);
    tryMatch(socket.id);
    broadcastStatus();
  });

  socket.on("message", (data) => {
    const partnerId = activeChats.get(socket.id);
    if (!partnerId) return;

    const text =
      typeof data === "string" ? data : typeof data?.text === "string" ? data.text : null;
    if (!text || text.trim().length === 0) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      socket.emit("error_msg", {
        message: `Message exceeds ${MAX_MESSAGE_LENGTH} character limit.`,
      });
      return;
    }

    if (!checkRateLimit(socket.id)) {
      socket.emit("error_msg", { message: "Slow down! Max 5 messages per second." });
      return;
    }

    io.to(partnerId).emit("message", { text, sender: "partner" });
  });

  socket.on("end_chat", () => {
    if (!activeChats.has(socket.id)) {
      removeFromQueue(socket.id);
      socket.emit("chat_ended");
      broadcastStatus();
      return;
    }

    const partnerId = endChat(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("partner_disconnected");
    }
    socket.emit("chat_ended");
    broadcastStatus();
  });

  socket.on("skip", () => {
    if (!activeChats.has(socket.id)) {
      removeFromQueue(socket.id);
      socket.emit("search_cancelled");
      broadcastStatus();
      return;
    }

    const partnerId = endChat(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("partner_disconnected");
    }
    tryMatch(socket.id);
    broadcastStatus();
  });

  socket.on("disconnect", () => {
    console.log(`[disconnect] ${socket.id}`);
    removeFromQueue(socket.id);
    rateLimitMap.delete(socket.id);
    userNames.delete(socket.id);

    const partnerId = endChat(socket.id);
    if (partnerId) {
      io.to(partnerId).emit("partner_disconnected");
    }
    broadcastStatus();
  });
});

// --------------- Health check ---------------

app.get("/", (_req, res) => {
  res.json({ status: "ok", queueSize: waitingQueue.length });
});

// --------------- Start ---------------

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
