import { Socket } from "socket.io";
import http from "http";

import express from 'express';
import { Server } from 'socket.io';
import { UserManager } from "./managers/UserManger";

const app = express();
// FIX: Pass express app to createServer, NOT http module
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const userManager = new UserManager();

io.on('connection', (socket: Socket) => {
  console.log('a user connected:', socket.id);
  
  // Extract name from auth or use default
  const userName = (socket.handshake.auth?.name as string) || `User-${socket.id.slice(-4)}`;
  console.log('User name:', userName);
  
  userManager.addUser(userName, socket);
  
  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id);
    userManager.removeUser(socket.id);
  });
});

// Use the port provided by environment variable PORT (Render injects this automatically)
const PORT = process.env.PORT|| 5001;

server.listen(PORT, () => {
    console.log(`listening on *:${PORT}`);
});
