const socket = io();

const elements = {
    localVideo: document.getElementById('lokalniVideo'),
    remoteVideo: document.getElementById('udaljeniVideo'),
    callBtn: document.getElementById('pozoviBtn'),
    muteBtn: document.getElementById('muteBtn'),
    shareBtn: document.getElementById('shareScreenBtn')
};

let localStream;
let peerConnection;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

async function initMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        elements.localVideo.srcObject = localStream;
    } catch (err) {
        console.error('Media error:', err);
    }
}

function createPeerConnection() {
    if (peerConnection) return;

    peerConnection = new RTCPeerConnection(rtcConfig);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        elements.remoteVideo.srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) socket.emit('ice-candidate', event.candidate);
    };

    peerConnection.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
            cleanupConnection();
        }
    };
}

function cleanupConnection() {
    elements.remoteVideo.srcObject = null;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
}

elements.callBtn.onclick = async () => {
    createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', offer);
};

elements.muteBtn.onclick = () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    elements.muteBtn.innerText = audioTrack.enabled ? "Ugasi Mikrofon" : "Upali Mikrofon";
    elements.muteBtn.style.background = audioTrack.enabled ? "#dc3545" : "#28a745";
};

elements.shareBtn.onclick = async () => {
    if (!peerConnection) return;
    try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        elements.localVideo.srcObject = screenStream;

        const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
        sender.replaceTrack(screenTrack);

        screenTrack.onended = () => {
            const cameraTrack = localStream.getVideoTracks()[0];
            sender.replaceTrack(cameraTrack);
            elements.localVideo.srcObject = localStream;
        };
    } catch (err) {
        console.error('Screen share aborted/failed:', err);
    }
};

socket.on('offer', async (offer) => {
    createPeerConnection();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', answer);
});

socket.on('answer', async (answer) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async (candidate) => {
    if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
    }
});

socket.on('peer-disconnected', cleanupConnection);

initMedia();