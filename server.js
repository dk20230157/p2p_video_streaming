const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const users = {};

const BOT_NAME = 'AI Bot';
const TRIGGER  = '@ai';

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'switch_room',
            description: 'Ubacuje korisnika u sobu (ili ga prebacuje iz trenutne u drugu).',
            parameters: {
                type: 'object',
                properties: { room: { type: 'string', description: 'Naziv sobe' } },
                required: ['room']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'leave_room',
            description: 'Izbacuje korisnika iz trenutne sobe.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_microphone',
            description: 'Uključuje ili isključuje (mutuje) mikrofon korisnika.',
            parameters: {
                type: 'object',
                properties: { on: { type: 'boolean', description: 'true = uključi mikrofon, false = mutuj' } },
                required: ['on']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_camera',
            description: 'Uključuje ili isključuje kameru korisnika.',
            parameters: {
                type: 'object',
                properties: { on: { type: 'boolean', description: 'true = uključi kameru, false = isključi' } },
                required: ['on']
            }
        }
    }
];

async function askAI(prompt) {
    console.log('Šaljem zahtev ka Groq');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let res;
    try {
        res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer ' + process.env.GROQ_API_KEY
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [
                    {
                        role: 'system',
                        content: 'Ti si asistent u aplikaciji za grupne video pozive. Odgovaraj kratko i na srpskom. ' +
                                 'Kad korisnik traži da ga ubaciš ili prebaciš u neku sobu, pozovi switch_room. ' +
                                 'Kad traži da izađe iz sobe / da ga izbaciš, pozovi leave_room. ' +
                                 'Kad traži da mu isključiš/uključiš mikrofon (mute/unmute), pozovi set_microphone. ' +
                                 'Kad traži da mu isključiš/uključiš kameru, pozovi set_camera.'
                    },
                    { role: 'user', content: prompt }
                ],
                tools: TOOLS,
                tool_choice: 'auto'
            })
        });
    } finally {
        clearTimeout(timeout);
    }

    console.log('Groq odgovorio, status:', res.status);

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error('API ' + res.status + ' — ' + errBody);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message || {};

    const tc = message.tool_calls?.[0];
    const toolUse = tc ? { name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') } : null;

    const text = (message.content || '').trim();

    return { text, toolUse };
}

/* ---------- Pomoćne funkcije za sobe ---------- */

function peersIn(room, exceptId) {
    return [...(io.sockets.adapter.rooms.get(room) || [])]
        .filter(id => id !== exceptId)
        .map(id => ({ id, name: users[id]?.name || 'Gost' }));
}

function switchRoom(socket, newRoom) {
    const u = users[socket.id];
    if (!u) return;
    socket.to(u.room).emit('peer-left', socket.id);   
    socket.leave(u.room);

    u.room = newRoom;
    socket.join(newRoom);

    socket.emit('room-switched', { room: newRoom, peers: peersIn(newRoom, socket.id) });
    socket.to(newRoom).emit('peer-joined', { id: socket.id, name: u.name });
}

function leaveRoom(socket) {
    const u = users[socket.id];
    if (!u) return;
    socket.to(u.room).emit('peer-left', socket.id);
    socket.leave(u.room);
    delete users[socket.id];
    socket.emit('left-room');
}

/* ---------- Izvršavanje bot akcija ---------- */

function runBotAction(socket, { text: reply, toolUse }, send) {
    const u = users[socket.id];

    if (toolUse?.name === 'switch_room') {
        const newRoom = String(toolUse.input.room || '').slice(0, 40).trim();
        if (!newRoom) return send(reply || 'Reci mi tačan naziv sobe.');
        send(reply || `Ubacujem te u sobu "${newRoom}".`);
        if (u) {
            switchRoom(socket, newRoom);        
        } else {
            socket.emit('bot-join', { room: newRoom });   
        }

    } else if (toolUse?.name === 'leave_room') {
        if (!u) return send('Trenutno nisi ni u jednoj sobi.');
        send(reply || 'Izbacujem te iz sobe. Vidimo se!');
        leaveRoom(socket);

    } else if (toolUse?.name === 'set_microphone' || toolUse?.name === 'set_camera') {
        if (!u) return send('Prvo uđi u neku sobu, pa ću moći to da uradim.');
        const on = !!toolUse.input.on;
        const device = toolUse.name === 'set_microphone' ? 'mic' : 'camera';
        const defaultMsg = device === 'mic'
            ? (on ? 'Uključujem ti mikrofon.' : 'Mutujem te.')
            : (on ? 'Uključujem ti kameru.' : 'Isključujem ti kameru.');
        send(reply || defaultMsg);
        socket.emit('set-media', { device, on });

    } else if (reply) {
        send(reply);

    } else {
        send('Nisam siguran šta tražiš — probaj da preformulišeš.');
    }
}

/* ---------- Socket veze ---------- */

io.on('connection', (socket) => {

    /* ---------- Ulazak u sobu ---------- */

    socket.on('join', ({ name, room }) => {
        name = (name || 'Gost').toString().slice(0, 40);
        room = (room || 'lobi').toString().slice(0, 40);
        users[socket.id] = { name, room };
        socket.join(room);

        socket.emit('peers', peersIn(room, socket.id));
        socket.to(room).emit('peer-joined', { id: socket.id, name });
    });

    /* ---------- Signalizacija ---------- */

    socket.on('offer', ({ target, offer }) =>
        io.to(target).emit('offer', { from: socket.id, offer }));

    socket.on('answer', ({ target, answer }) =>
        io.to(target).emit('answer', { from: socket.id, answer }));

    socket.on('ice-candidate', ({ target, candidate }) =>
        io.to(target).emit('ice-candidate', { from: socket.id, candidate }));

    /* ---------- Stanje kamere ---------- */

    socket.on('cam-state', (on) => {
        const u = users[socket.id];
        if (u) socket.to(u.room).emit('cam-state', { from: socket.id, on: !!on });
    });

    /* ---------- Grupni chat + @ai bot ---------- */

    socket.on('chat', async (text) => {
        const u = users[socket.id];
        if (!u) return;

        text = String(text).slice(0, 500);
        io.to(u.room).emit('chat', { name: u.name, text });   

        if (!text.toLowerCase().startsWith(TRIGGER)) return;

        const prompt = text.slice(TRIGGER.length).trim();
        if (!prompt) return;

        const room = u.room;   
        const send = (t) => io.to(room).emit('chat', { name: BOT_NAME, text: t });

        try {
            const result = await askAI(prompt);
            runBotAction(socket, result, send);
        } catch (e) {
            send('Greška: ' + e.message);
        }
    });

    /* ---------- Privatni razgovor sa botom (widget) ---------- */

    socket.on('bot-msg', async (text) => {
        text = String(text || '').slice(0, 500).trim();
        if (!text) return;

        const send = (t) => socket.emit('bot-msg', { text: t });

        try {
            const result = await askAI(text);
            runBotAction(socket, result, send);
        } catch (e) {
            send('Greška: ' + e.message);
        }
    });

    /* ---------- Prekid veze ---------- */

    socket.on('disconnect', () => {
        const u = users[socket.id];
        if (u) socket.to(u.room).emit('peer-left', socket.id);
        delete users[socket.id];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Signal server: http://localhost:${PORT}`));