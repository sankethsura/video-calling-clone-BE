const express = require('express');
const https = require('https');
const fs = require('fs');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || "https://localhost:3000",
  credentials: true
}));

let server;

if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
  const options = {
    key: fs.readFileSync(process.env.SSL_KEY_PATH),
    cert: fs.readFileSync(process.env.SSL_CERT_PATH)
  };
  server = https.createServer(options, app);
  console.log('HTTPS server configured');
} else {
  console.log('SSL certificates not found, falling back to HTTP');
  server = require('http').createServer(app);
}

const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const rooms = new Map();

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL,
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL
  });
}

function createRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      participants: new Set(),
      createdAt: new Date()
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
        io.to(remainingParticipant).emit('peer-left');
      }
      
      return roomId;
    }
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId) => {
    console.log(`User ${socket.id} attempting to join room: ${roomId}`);
    
    const room = createRoom(roomId);
    
    if (room.participants.size >= 2) {
      socket.emit('room-full', { roomId });
      return;
    }
    
    room.participants.add(socket.id);
    socket.join(roomId);
    
    if (room.participants.size === 1) {
      socket.emit('room-created', { 
        roomId, 
        isInitiator: true,
        iceServers: ICE_SERVERS 
      });
    } else {
      socket.emit('room-joined', { 
        roomId, 
        isInitiator: false,
        iceServers: ICE_SERVERS 
      });
      
      const otherParticipant = Array.from(room.participants).find(id => id !== socket.id);
      if (otherParticipant) {
        io.to(otherParticipant).emit('peer-joined', { peerId: socket.id });
      }
    }
    
    console.log(`Room ${roomId} now has ${room.participants.size} participants`);
  });

  socket.on('offer', (data) => {
    console.log(`Received offer from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit('offer', {
      offer: data.offer,
      from: socket.id
    });
  });

  socket.on('answer', (data) => {
    console.log(`Received answer from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit('answer', {
      answer: data.answer,
      from: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    console.log(`Received ICE candidate from ${socket.id} to ${data.target}`);
    socket.to(data.target).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });

  socket.on('leave', () => {
    console.log(`User ${socket.id} is leaving`);
    const roomId = removeFromRoom(socket.id);
    if (roomId) {
      socket.leave(roomId);
      socket.emit('left-room', { roomId });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    removeFromRoom(socket.id);
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'WebRTC Signaling Server',
    version: '1.0.0',
    protocol: req.protocol,
    endpoints: {
      health: '/health',
      rooms: '/rooms'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    totalParticipants: Array.from(rooms.values()).reduce((sum, room) => sum + room.participants.size, 0),
    protocol: req.protocol
  });
});

app.get('/rooms', (req, res) => {
  const roomData = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    participants: room.participants.size,
    createdAt: room.createdAt
  }));
  res.json(roomData);
});

const PORT = process.env.PORT || 8000;

server.listen(PORT, () => {
  const protocol = process.env.SSL_KEY_PATH ? 'https' : 'http';
  console.log(`WebRTC Signaling Server running on ${protocol}://localhost:${PORT}`);
  console.log(`Health check available at ${protocol}://localhost:${PORT}/health`);
});