const socket = io();

const config = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

let localStream = null;
let myName = '';
let micOn = true, camOn = true;

const peers = {};
const pending = {};
const names = {};

/* ---------- DOM reference ---------- */

const $ = id => document.getElementById(id);
const joinScreen = $('joinScreen'), callScreen = $('callScreen');
const nameInput = $('nameInput'), roomInput = $('roomInput'), joinBtn = $('joinBtn');
const grid = $('grid'), localVideo = $('localVideo');
const micBtn = $('micBtn'), camBtn = $('camBtn'), leaveBtn = $('leaveBtn');
const chatBox = $('chatBox'), chatInput = $('chatInput'), chatSend = $('chatSend');
const botWidget = $('botWidget'), botHeader = $('botHeader');
const botMessages = $('botMessages'), botInput = $('botInput'), botSend = $('botSend');

/* ---------- Ulazak u sobu ---------- */

async function joinRoom(room) {
    myName = nameInput.value.trim() || 'Gost';
    room = (room || roomInput.value.trim() || 'lobi').toString();

    if (!localStream) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (err) {
            alert('Nema pristupa kameri/mikrofonu: ' + err.message);
            return;
        }
        localVideo.srcObject = localStream;
    }

    joinScreen.classList.add('hidden');
    callScreen.classList.remove('hidden');
    socket.emit('join', { name: myName, room });
}

joinBtn.onclick = () => joinRoom();

/* ---------- WebRTC veza ---------- */

function createPeer(id) {
    const pc = new RTCPeerConnection(config);
    peers[id] = pc;
    pending[id] = pending[id] || [];

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('ice-candidate', { target: id, candidate: e.candidate });
    };

    pc.ontrack = (e) => showVideo(id, e.streams[0]);

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setStatus(id, false);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') removePeer(id);
    };

    return pc;
}

async function addPending(id) {
    if (!pending[id] || !peers[id]) return;
    for (const c of pending[id]) {
        try { await peers[id].addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    pending[id] = [];
}

/* ---------- Povezivanje sa listom peer-ova ---------- */

async function connectToPeers(list) {
    for (const { id, name } of list) {
        names[id] = name;
        addTile(id, name);
        const pc = createPeer(id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: id, offer });
    }
}

/* ---------- Signalizacija ---------- */

socket.on('peers', connectToPeers);

socket.on('peer-joined', ({ id, name }) => {
    names[id] = name;
    addTile(id, name);
});

socket.on('offer', async ({ from, offer }) => {
    const pc = peers[from] || createPeer(from);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await addPending(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { target: from, answer });
});

socket.on('answer', async ({ from, answer }) => {
    const pc = peers[from];
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await addPending(from);
});

socket.on('ice-candidate', async ({ from, candidate }) => {
    const pc = peers[from];
    if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch {}
    } else {
        (pending[from] = pending[from] || []).push(candidate);
    }
});

socket.on('peer-left', removePeer);

/* ---------- Bot: ulazak / promena sobe ---------- */

socket.on('bot-join', ({ room }) => joinRoom(room));

socket.on('room-switched', async ({ room, peers: list }) => {
    Object.keys(peers).forEach(removePeer);   
    await connectToPeers(list);
});

/* ---------- Bot: izlazak iz sobe ---------- */

socket.on('left-room', () => {
    Object.keys(peers).forEach(removePeer);
    chatBox.innerHTML = '';
    callScreen.classList.add('hidden');
    joinScreen.classList.remove('hidden');
});

/* ---------- Bot: daljinsko upravljanje mikrofonom / kamerom ---------- */

socket.on('set-media', ({ device, on }) => {
    if (!localStream) return;
    if (device === 'mic') setMic(on);
    if (device === 'camera') setCam(on);
});

/* ---------- Video pločice ---------- */

function addTile(id, name) {
    if (document.getElementById('tile-' + id)) return;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = 'tile-' + id;

    const video = document.createElement('video');
    video.id = 'video-' + id;
    video.autoplay = true;
    video.playsInline = true;

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;

    const status = document.createElement('span');
    status.className = 'status';
    status.id = 'status-' + id;
    status.textContent = 'Povezujem se…';

    const camOff = document.createElement('div');
    camOff.className = 'cam-off hidden';
    camOff.id = 'camoff-' + id;
    camOff.textContent = 'Kamera isključena';

    tile.append(video, label, status, camOff);
    grid.appendChild(tile);
}

function showVideo(id, stream) {
    addTile(id, names[id] || 'Gost');
    const video = document.getElementById('video-' + id);
    if (video) video.srcObject = stream;
}

function setStatus(id, connecting) {
    const el = document.getElementById('status-' + id);
    if (el) el.classList.toggle('hidden', !connecting);
}

function removePeer(id) {
    if (peers[id]) { peers[id].close(); delete peers[id]; }
    delete pending[id];
    delete names[id];
    const tile = document.getElementById('tile-' + id);
    if (tile) tile.remove();
}

/* ---------- Kontrole ---------- */

function setMic(on) {
    micOn = on;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    micBtn.textContent = micOn ? 'Mikrofon' : 'Mikrofon isključen';
    micBtn.classList.toggle('off', !micOn);
}

function setCam(on) {
    camOn = on;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    camBtn.textContent = camOn ? 'Kamera' : 'Kamera isključena';
    camBtn.classList.toggle('off', !camOn);
    socket.emit('cam-state', camOn);
}

micBtn.onclick = () => setMic(!micOn);
camBtn.onclick = () => setCam(!camOn);

socket.on('cam-state', ({ from, on }) => {
    const el = document.getElementById('camoff-' + from);
    if (el) el.classList.toggle('hidden', on);
});

leaveBtn.onclick = () => location.reload();

/* ---------- Grupni chat ---------- */

function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat', text);
    chatInput.value = '';
}
chatSend.onclick = sendChat;
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

socket.on('chat', ({ name, text }) => {
    const line = document.createElement('div');
    line.className = 'msg';
    const who = document.createElement('b');
    who.textContent = name + ': ';
    line.append(who, document.createTextNode(text));
    chatBox.appendChild(line);
    chatBox.scrollTop = chatBox.scrollHeight;
});

/* ---------- AI Bot widget ---------- */

function botAppend(text, who) {
    const div = document.createElement('div');
    div.className = 'bot-msg ' + who;
    div.textContent = text;
    botMessages.appendChild(div);
    botMessages.scrollTop = botMessages.scrollHeight;
}

function sendBotMsg() {
    const text = botInput.value.trim();
    if (!text) return;
    botAppend(text, 'me');
    socket.emit('bot-msg', text);
    botInput.value = '';
}

botSend.onclick = sendBotMsg;
botInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendBotMsg(); });

socket.on('bot-msg', ({ text }) => botAppend(text, 'bot'));

botHeader.onclick = () => botWidget.classList.toggle('collapsed');