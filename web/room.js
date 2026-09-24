// P2P mesh room. One RTCPeerConnection per remote participant, negotiated with
// the W3C "perfect negotiation" pattern so either side can renegotiate (e.g.
// screen share mid-call) without offer glare.

const params = new URLSearchParams(location.search);
const meetingId = params.get("m");
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];

const $ = (s) => document.querySelector(s);
const grid = $("#grid");

/** @type {Map<string, {pc: RTCPeerConnection, info: any, polite: boolean, makingOffer: boolean, ignoreOffer: boolean, meta: any, screenSender: RTCRtpSender | null}>} */
const peers = new Map();
let ws;
let selfId = null;
let meeting = null;
let local = new MediaStream();
let screen = null;

// Exposed for e2e tests (bots read connection state and stats).
window.__room = { peers, get selfId() { return selfId; }, get recorderPresent() { return $("#ai-banner").classList.contains("on"); } };

if (!meetingId) document.body.innerHTML = "<main>Missing meeting id. <a href='/'>Create one</a>.</main>";

const autoName = params.get("name");
if (autoName) join(autoName, params.get("bot") === "1");
$("#join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  join(new FormData(e.target).get("name"), false);
});

async function join(name, bot) {
  $("#join-form").hidden = true;
  $("#controls").hidden = false;
  try {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 360 } });
  } catch {
    local = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => new MediaStream());
  }
  addTile("self", local, `${name} (you)`, true);

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => send({ type: "join", meetingId, name, bot });
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = () => setStatus("disconnected");
}

function send(msg) {
  ws.send(JSON.stringify(msg));
}

function onServer(msg) {
  switch (msg.type) {
    case "welcome":
      selfId = msg.selfId;
      meeting = msg.meeting;
      $("#title").textContent = meeting.title;
      setRecorder(!!msg.recorder);
      startClock();
      for (const p of msg.peers) createPeer(p);
      break;
    case "peer-joined":
      createPeer(msg.peer);
      break;
    case "peer-left":
      removePeer(msg.id);
      break;
    case "recorder-joined":
      setRecorder(true);
      break;
    case "recorder-left":
      setRecorder(false);
      break;
    case "signal":
      onSignal(msg.from, msg.data);
      break;
    case "ended":
      setStatus("meeting ended");
      leave();
      break;
    case "error":
      setStatus(`error: ${msg.message}`);
      break;
  }
}

function createPeer(info) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const peer = { pc, info, polite: selfId < info.id, makingOffer: false, ignoreOffer: false, meta: {}, screenSender: null };
  peers.set(info.id, peer);
  const signal = (data) => send({ type: "signal", to: info.id, data });

  for (const track of local.getTracks()) pc.addTrack(track, local);
  if (screen) peer.screenSender = pc.addTrack(screen.getVideoTracks()[0], screen);
  signal({ meta: streamMeta() });

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      signal({ description: pc.localDescription });
    } catch (err) {
      console.error(err);
    } finally {
      peer.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => candidate && signal({ candidate });
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0];
    if (!stream) return;
    addTile(`${info.id}:${stream.id}`, stream, label(peer, stream.id), false, stream.id === peer.meta.screen);
    stream.onremovetrack = () => stream.getTracks().length === 0 && removeTile(`${info.id}:${stream.id}`);
    track.onended = () => stream.getTracks().length === 0 && removeTile(`${info.id}:${stream.id}`);
  };
  pc.onconnectionstatechange = () => setStatus(`${info.name}: ${pc.connectionState}`);
}

async function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  const { pc } = peer;
  try {
    if (data.meta) {
      peer.meta = data.meta;
      for (const tile of grid.querySelectorAll(`[data-key^="${from}:"]`)) {
        tile.querySelector("label").textContent = label(peer, tile.dataset.key.split(":")[1]);
        tile.classList.toggle("screen", tile.dataset.key.endsWith(`:${peer.meta.screen}`));
      }
    } else if (data.description) {
      const collision = data.description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        await pc.setLocalDescription();
        send({ type: "signal", to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!peer.ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error(err);
  }
}

function removePeer(id) {
  peers.get(id)?.pc.close();
  peers.delete(id);
  for (const tile of grid.querySelectorAll(`[data-key^="${id}:"]`)) tile.remove();
}

function streamMeta() {
  return { camera: local.id, screen: screen?.id ?? null };
}

function label(peer, streamId) {
  return streamId === peer.meta.screen ? `${peer.info.name} — screen` : peer.info.name;
}

// ---- controls ----

$("#mic").onclick = (e) => toggle(local.getAudioTracks(), e.target);
$("#cam").onclick = (e) => toggle(local.getVideoTracks(), e.target);
$("#leave").onclick = () => leave();

// Dev-only: server exposes /dev/* only with NODE_ENV=development.
fetch("/dev/ping").then((r) => r.ok && ($("#add-bot").hidden = false)).catch(() => {});
$("#add-bot").onclick = async (e) => {
  e.target.disabled = true;
  const res = await fetch(`/dev/meetings/${meetingId}/bots`, { method: "POST" });
  setStatus(res.ok ? `added ${(await res.json()).name}` : "bot failed");
  e.target.disabled = false;
};
$("#share").onclick = async (e) => {
  if (screen) return stopShare();
  screen = await navigator.mediaDevices.getDisplayMedia({ video: true }).catch(() => null);
  if (!screen) return;
  const track = screen.getVideoTracks()[0];
  track.onended = stopShare; // browser's own "Stop sharing" button
  addTile("self-screen", screen, "Your screen", true, true);
  e.target.textContent = "Stop sharing";
  for (const [id, peer] of peers) {
    send({ type: "signal", to: id, data: { meta: streamMeta() } });
    peer.screenSender = peer.pc.addTrack(track, screen);
  }
};

function stopShare() {
  if (!screen) return;
  for (const t of screen.getTracks()) t.stop();
  for (const peer of peers.values()) {
    if (peer.screenSender) peer.pc.removeTrack(peer.screenSender);
    peer.screenSender = null;
  }
  screen = null;
  removeTile("self-screen");
  $("#share").textContent = "Share screen";
  for (const id of peers.keys()) send({ type: "signal", to: id, data: { meta: streamMeta() } });
}

function toggle(tracks, button) {
  for (const t of tracks) t.enabled = !t.enabled;
  button.classList.toggle("off", tracks.some((t) => !t.enabled));
}

function leave() {
  stopShare();
  for (const id of [...peers.keys()]) removePeer(id);
  for (const t of local.getTracks()) t.stop();
  ws?.close();
  $("#controls").hidden = true;
}

// ---- ui ----

function addTile(key, stream, text, muted = false, isScreen = false) {
  let tile = grid.querySelector(`[data-key="${key}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.key = key;
    tile.innerHTML = "<video autoplay playsinline></video><label></label>";
    grid.append(tile);
  }
  const video = tile.querySelector("video");
  video.muted = muted;
  video.srcObject = stream;
  tile.querySelector("label").textContent = text;
  tile.classList.toggle("screen", isScreen);
}

function removeTile(key) {
  grid.querySelector(`[data-key="${key}"]`)?.remove();
}

function setRecorder(on) {
  $("#ai-banner").classList.toggle("on", on);
}

function setStatus(text) {
  $("#status").textContent = text;
}

function startClock() {
  const tick = () => {
    const left = Math.max(0, meeting.startedAt + meeting.durationMs - Date.now());
    const m = Math.floor(left / 60_000);
    const s = String(Math.floor(left / 1000) % 60).padStart(2, "0");
    $("#clock").textContent = `${m}:${s} left`;
  };
  tick();
  setInterval(tick, 1000);
}
