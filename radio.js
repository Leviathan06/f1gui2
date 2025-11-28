let socket;
let localStream;
let peers = {};
let senders = {};
let myRole;
let myTeam;
let myName = "";

let pttActive = false;
let isBroadcastMode = false;
let directorListenTeam = "all";
let directorSpeakTeam = "none";

const RADIO_BEEP_URL = "f1-radio-beep.mp3";

// 비주얼라이저 관리
let visualizers = {}; // { speakerId: {canvas,ctx,analyser,audioCtx,removeTimer} }

// ---------------- UI 업데이트 ----------------
function updateUI() {
  const mic = document.getElementById("micStatus");
  mic.textContent = pttActive ? "마이크: 송출 중" : "마이크: 대기중";
  mic.className = pttActive ? "active" : "";

  const sendMode = document.getElementById("sendModeStatus");

  if (myRole === "director") {
    if (directorSpeakTeam === "all") {
      sendMode.textContent = "송출: 전체";
      sendMode.className = "active";
    } else if (directorSpeakTeam === "none") {
      sendMode.textContent = "송출: 없음";
      sendMode.className = "";
    } else {
      sendMode.textContent = "송출: " + directorSpeakTeam;
      sendMode.className = "active";
    }
  } else {
    sendMode.textContent = "송출: 내 팀";
  }
}

// ---------------- 시작 버튼 ----------------
document.getElementById("startBtn").onclick = async () => {
  myRole = document.getElementById("role").value;
  myTeam = document.getElementById("team").value;
  myName = document.getElementById("userName").value;

  document.getElementById("setup").style.display = "none";
  document.getElementById("controls").style.display = "block";

  if (myRole === "director") {
    document.getElementById("directorTeamSelect").style.display = "inline-block";
    document.getElementById("directorSpeakSelect").style.display = "inline-block";
  }

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  connectSignaling();
  setupKeys();
  setupDirectorUI();
  updateUI();
};

// ---------------- 시그널링 서버 연결 ----------------
function connectSignaling() {
  socket = new WebSocket("wss:https://f1radio-signaling-leviathan06.onrender.com/");

  socket.onmessage = async evt => {
    console.log("[SIGNALING:RECV]", evt.data);
    const data = JSON.parse(evt.data);

    // 상대 이름
    const speakerName = data.fromName || data.from;

    // 디렉터가 아니면 내 팀 혹은 all만 받음
    if (myRole !== "director" && data.to !== myTeam && data.to !== "all") return;

    // ----- OFFER -----
    if (data.type === "offer") {
      const pc = createPeerConnection(data.from, speakerName);
      await pc.setRemoteDescription(data.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.send(JSON.stringify({
        
        type: "answer",
        answer,
        to: data.from,
        from: myTeam,
        fromName: myName
      }));
    }

    // ----- ANSWER -----
    if (data.type === "answer") {
      peers[data.from].setRemoteDescription(data.answer);
    }

    // ----- ICE -----
    if (data.type === "ice") {
      peers[data.from].addIceCandidate(data.ice);
    }
  };
}

// ---------------- RTC Peer 생성 ----------------
function createPeerConnection(id, speakerName) {
  const pc = new RTCPeerConnection();

  pc.onicecandidate = evt => {
    if (evt.candidate) {
      socket.send(JSON.stringify({
        type: "ice",
        ice: evt.candidate,
        to: id,
        from: myTeam,
        fromName: myName
      }));
    }
  };

  pc.ontrack = evt => {
    const stream = evt.streams[0];

    // ----- 레이스 디렉터 -----
    if (myRole === "director") {
      if (directorListenTeam === "all" || directorListenTeam === id) {
        const audio = new Audio();
        audio.srcObject = stream;
        audio.play();
        activateVisualizer(id, speakerName, stream);
      }
      return;
    }

    // ----- 드라이버 -----
    if (myRole === "driver" && id === myTeam) {
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play();
      activateVisualizer(id + "_" + speakerName, speakerName, stream);
    }
  };

  peers[id] = pc;
  return pc;
}

// ---------------- 디렉터 UI ----------------
function setupDirectorUI() {
  document.getElementById("directorTeamSelect").onchange = e => {
    directorListenTeam = e.target.value;
  };

  document.getElementById("directorSpeakSelect").onchange = e => {
    directorSpeakTeam = e.target.value;
    updateUI();
  };
}

// ---------------- 키 이벤트 ----------------
function setupKeys() {
  window.addEventListener("keydown", e => {
    console.log(localStream.getAudioTracks()[0].readyState);
    if (e.code === "Space" && !pttActive) {
      pttActive = true;
      playBeepImmediate().then(() => startPTT());
      updateUI();
    }

    if (e.code === "KeyZ") {
      isBroadcastMode = !isBroadcastMode;
      updateUI();
    }
  });

  window.addEventListener("keyup", e => {
    if (e.code === "Space") {
      e.preventDefault();
      pttActive = false;
      stopPTT();
      updateUI();
    }
  });
}

// ---------------- PTT ----------------
function playBeepImmediate() {
  return new Promise(res => {
    const beep = new Audio(RADIO_BEEP_URL);
    beep.onerror = res;
    beep.onended = res;
    beep.play().catch(res);
  });
}

async function startPTT() {
  try {
    sendAudio();
  } catch (e) {}
}

function stopPTT() {
  stopSending();
  updateUI();
}

// ---------------- 송출 ----------------
function sendAudio() {
  const audioTrack = localStream.getAudioTracks()[0];

  Object.entries(peers).forEach(([id, pc]) => {
    if (myRole === "driver") {
      if (id === myTeam) {
        if (!senders[id]) {
          senders[id] = pc.addTrack(audioTrack);
        }
      }
      return;
    }

    if (myRole === "director") {
      if (directorSpeakTeam === "none") return;
      if (directorSpeakTeam === "all" || directorSpeakTeam === id) {
        if (!senders[id]) senders[id] = pc.addTrack(audioTrack);
      }
    }
  });
}

function stopSending() {
  Object.values(peers).forEach(pc => {
    pc.getSenders().forEach(sender => {
      if (sender && sender.track && sender.track.kind === "audio") {
        pc.removeTrack(sender);
      }
    });
  });
}

// ---------------- 비주얼라이저 ----------------
function activateVisualizer(speakerId, speakerName, stream) {
  if (visualizers[speakerId]) {
    clearTimeout(visualizers[speakerId].removeTimer);
  } else {
    createVisualizerBox(speakerId, speakerName, stream);
  }

  startVisualizerAnimation(speakerId);
}

function createVisualizerBox(speakerId, speakerName, stream) {
  const area = document.getElementById("visualizerArea");

  const box = document.createElement("div");
  box.className = "visBox";
  box.id = "visBox_" + speakerId;

  const nameDiv = document.createElement("div");
  nameDiv.className = "speakerName";
  nameDiv.textContent = speakerName;

  const canvas = document.createElement("canvas");
  canvas.className = "visCanvas";
  canvas.width = 150;
  canvas.height = 60;

  box.appendChild(nameDiv);
  box.appendChild(canvas);
  area.appendChild(box);

  const ctx = canvas.getContext("2d");
  const audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);

  visualizers[speakerId] = {
    canvas,
    ctx,
    analyser,
    audioCtx,
    removeTimer: null
  };
}

function startVisualizerAnimation(speakerId) {
  const v = visualizers[speakerId];
  if (!v) return;

  const analyser = v.analyser;
  const canvas = v.canvas;
  const ctx = v.ctx;

  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    if (!visualizers[speakerId]) return;

    requestAnimationFrame(draw);

    analyser.getByteFrequencyData(data);

    const level = data.reduce((a,b)=>a+b,0) / data.length;
    if (level < 2) {
      if (!v.removeTimer) {
        v.removeTimer = setTimeout(() => removeVisualizer(speakerId), 700);
      }
    } else {
      clearTimeout(v.removeTimer);
      v.removeTimer = null;
    }

    ctx.clearRect(0,0,canvas.width,canvas.height);

    const barWidth = 4;
    let x = 0;

    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] / 255;
      const barHeight = value * canvas.height;

      ctx.fillStyle = "#00ffea";
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

      x += barWidth + 2;
    }
  }

  draw();
}

function removeVisualizer(speakerId) {
  const v = visualizers[speakerId];
  if (!v) return;

  v.audioCtx.close().catch(()=>{});
  delete visualizers[speakerId];

  const box = document.getElementById("visBox_" + speakerId);
  if (box) box.remove();
}