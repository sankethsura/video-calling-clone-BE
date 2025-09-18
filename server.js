const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(cors({
  origin: "*",
  credentials: false
}));

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  }
});

const rooms = new Map();

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

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
        stunServers: STUN_SERVERS 
      });
    } else {
      socket.emit('room-joined', { 
        roomId, 
        isInitiator: false,
        stunServers: STUN_SERVERS 
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
    totalParticipants: Array.from(rooms.values()).reduce((sum, room) => sum + room.participants.size, 0)
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

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`WebRTC Signaling Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});