const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
    const roomId = 'room-1'; 
    socket.join(roomId);

    socket.on('offer', (data) => socket.to(roomId).emit('offer', data));
    socket.on('answer', (data) => socket.to(roomId).emit('answer', data));
    socket.on('ice-candidate', (data) => socket.to(roomId).emit('ice-candidate', data));

    socket.on('disconnect', () => {
        socket.to(roomId).emit('peer-disconnected');
    });
});

server.listen(3000, () => console.log('Listening on :3000'));


