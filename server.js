const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
const server = http.createServer(app);

console.log("app running");
app.use(helmet());
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://video-calling-clone.vercel.app",
      "http://ec2-13-233-89-60.ap-south-1.compute.amazonaws.com",
    ],
    credentials: false,
  })
);

const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://video-calling-clone.vercel.app",
      "http://ec2-13-233-89-60.ap-south-1.compute.amazonaws.com",
    ],
    methods: ["GET", "POST"],
    credentials: false,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

const rooms = new Map();

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      participants: new Set(),
      createdAt: new Date(),
    });
  }
  return rooms.get(roomId);
}

function removeFromRoom(socketId) {
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.has(socketId)) {
      room.participants.delete(socketId);

      if (room.participants.size === 0) {
        rooms.delete(roomId);
      } else {
        const remainingParticipant = Array.from(room.participants)[0];
        io.to(remainingParticipant).emit("peer-left");
      }

      return roomId;
    }
  }
  return null;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (roomId) => {
    console.log(`User ${socket.id} attempting to join room: ${roomId}`);

    const room = createRoom(roomId);

    if (room.participants.size >= 2) {
      socket.emit("room-full", { roomId });
      return;
    }

    // Get existing participants before adding new one
    const existingParticipants = Array.from(room.participants);
    console.log(`Existing participants in room ${roomId}:`, existingParticipants);

    room.participants.add(socket.id);
    socket.join(roomId);

    if (room.participants.size === 1) {
      socket.emit("room-created", {
        roomId,
        isInitiator: true,
        stunServers: STUN_SERVERS,
      });
    } else {
      socket.emit("room-joined", {
        roomId,
        isInitiator: false,
        stunServers: STUN_SERVERS,
      });

      // Notify each existing participant about the new peer
      existingParticipants.forEach((participantId) => {
        console.log(`Sending peer-joined event from ${socket.id} to ${participantId}`);
        io.to(participantId).emit("peer-joined", { peerId: socket.id });
      });
    }

    console.log(`Room ${roomId} now has ${room.participants.size} participants`);
  });

  socket.on("offer", (data) => {
    console.log(`Received offer from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit("offer", {
      offer: data.offer,
      from: socket.id,
    });
  });

  socket.on("answer", (data) => {
    console.log(`Received answer from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit("answer", {
      answer: data.answer,
      from: socket.id,
    });
  });

  socket.on("ice-candidate", (data) => {
    console.log(`Received ICE candidate from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit("ice-candidate", {
      candidate: data.candidate,
      from: socket.id,
    });
  });

  socket.on("leave", () => {
    console.log(`User ${socket.id} is leaving`);
    const roomId = removeFromRoom(socket.id);
    if (roomId) {
      socket.leave(roomId);
      socket.emit("left-room", { roomId });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    removeFromRoom(socket.id);
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "WebRTC Signaling Server",
    version: "1.0.0",
    client: process.env.CLIENT_URL,
    endpoints: {
      health: "/health",
      rooms: "/rooms",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    rooms: rooms.size,
    totalParticipants: Array.from(rooms.values()).reduce(
      (sum, room) => sum + room.participants.size,
      0
    ),
  });
});

app.get("/rooms", (req, res) => {
  const roomData = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    participants: room.participants.size,
    createdAt: room.createdAt,
  }));
  res.json(roomData);
});

const PORT = process.env.PORT || 8000;

server.listen(PORT, () => {
  console.log(`WebRTC Signaling Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
