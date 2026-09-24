// Meeting room. P2P mesh: one RTCPeerConnection per remote participant,
// negotiated with the W3C "perfect negotiation" pattern so either side can
// renegotiate (screen share mid-call) without offer glare.

const params = new URLSearchParams(location.search);
const meetingId = params.get("m");
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const SPEAKING_RMS = 0.02;

const $ = (s) => document.querySelector(s);
const grid = $("#grid");

/** @type {Map<string, {pc: RTCPeerConnection, info: any, polite: boolean, makingOffer: boolean, ignoreOffer: boolean, meta: any, screenSender: RTCRtpSender | null}>} */
const peers = new Map();
let ws;
let selfId = null;
let selfName = "";
let meeting = null;
let local = new MediaStream();
let screen = null;
let audioCtx = null;
const levels = new Map(); // tile key -> analyser

// Exposed for e2e tests (bots read connection state and stats).
window.__room = { peers, get selfId() { return selfId; }, get recorderPresent() { return $("#rec").classList.contains("on"); } };

if (!meetingId) location.replace("/");
init();

async function init() {
  const res = await fetch(`/api/meetings/${meetingId}`);
  if (!res.ok) {
    $("#title").textContent = "Session not found";
    $("#greenroom").innerHTML = `<div class="empty-stage"><div><strong>No session with code ${meetingId}.</strong></div><a class="btn" href="/">Back</a></div>`;
    return;
  }
  meeting = await res.json();
  renderMeeting();
  setInterval(renderClock, 1000);

  const autoName = params.get("name"); // bots join directly, skipping the green room
  if (autoName) return join(autoName, params.get("bot") === "1", await getMedia({}));

  $("#name").value = localStorage.getItem("scribe:name") ?? "";
  await startPreview({});
  $("#mic-select").onchange = () => startPreview({ mic: $("#mic-select").value, cam: $("#cam-select").value });
  $("#cam-select").onchange = () => startPreview({ mic: $("#mic-select").value, cam: $("#cam-select").value });
  $("#join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#name").value.trim();
    try { localStorage.setItem("scribe:name", name); } catch {}
    join(name, false, local);
  });
  $("#name").focus();
}

// ---------- devices / green room ----------

async function getMedia({ mic, cam }) {
  const audio = mic ? { deviceId: { exact: mic } } : true;
  const video = cam === "off" ? false : { width: 1280, height: 720, ...(cam ? { deviceId: { exact: cam } } : {}) };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio }).catch(() => new MediaStream());
  }
}

async function startPreview(choice) {
  for (const t of local.getTracks()) t.stop();
  local = await getMedia(choice);
  $("#preview").srcObject = local;
  $("#preview-empty").hidden = local.getVideoTracks().length > 0;
  watchLevel("preview", local, (rms) => ($("#meter").style.width = `${Math.min(100, rms * 600)}%`));

  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current, extra = []) => {
    sel.innerHTML = "";
    for (const d of [...devices.filter((d) => d.kind === kind), ...extra]) {
      sel.add(new Option(d.label || `${kind} ${sel.length + 1}`, d.deviceId, false, d.deviceId === current));
    }
  };
  fill($("#mic-select"), "audioinput", local.getAudioTracks()[0]?.getSettings().deviceId);
  fill($("#cam-select"), "videoinput", local.getVideoTracks()[0]?.getSettings().deviceId ?? "off", [{ label: "No camera", deviceId: "off" }]);
}

// ---------- join / signaling ----------

function join(name, bot, stream) {
  selfName = name;
  local = stream;
  levels.delete("preview");
  $("#greenroom").hidden = true;
  $("#incall").hidden = false;
  $("#transport").hidden = false;
  addTile("self", local, `${name} (you)`, { muted: true, self: true });
  syncSelfTile();

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => send({ type: "join", meetingId, name, bot });
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = () => setStatus("Disconnected");
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onServer(msg) {
  switch (msg.type) {
    case "welcome":
      selfId = msg.selfId;
      meeting = msg.meeting;
      renderMeeting();
      setRecorder(!!msg.recorder);
      logEvent(`${selfName} joined`, true);
      for (const p of msg.peers) createPeer(p);
      updateAlone();
      break;
    case "peer-joined":
      createPeer(msg.peer);
      logEvent(`${msg.peer.name} joined`, true);
      updateAlone();
      break;
    case "peer-left": {
      const name = peers.get(msg.id)?.info.name;
      removePeer(msg.id);
      if (name) logEvent(`${name} left`, true);
      updateAlone();
      break;
    }
    case "recorder-joined":
      setRecorder(true);
      logEvent("Scribe online", true);
      break;
    case "recorder-left":
      setRecorder(false);
      logEvent("Scribe offline", true);
      break;
    case "signal":
      onSignal(msg.from, msg.data);
      break;
    case "ended":
      leave("Session ended — it reached its set length.");
      break;
    case "error":
      setStatus(msg.message === "meeting ended" ? "This session has ended." : `Error: ${msg.message}`);
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
  signal({ meta: selfMeta() });

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
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream) return;
    const key = `${info.id}:${stream.id}`;
    const isScreen = stream.id === peer.meta.screen;
    addTile(key, stream, tileName(peer, stream.id), { screen: isScreen, bot: info.bot });
    syncPeerTiles(peer);
    const drop = () => stream.getTracks().length === 0 && removeTile(key);
    stream.onremovetrack = drop;
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") setStatus(`Connection to ${info.name} failed`);
  };
}

async function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  const { pc } = peer;
  try {
    if (data.meta) {
      peer.meta = data.meta;
      syncPeerTiles(peer);
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
  for (const tile of grid.querySelectorAll(`[data-key^="${id}:"]`)) removeTile(tile.dataset.key);
}

// What peers need to render us: which stream is which, and mic/cam state.
function selfMeta() {
  return {
    camera: local.id,
    screen: screen?.id ?? null,
    mic: local.getAudioTracks().some((t) => t.enabled),
    cam: local.getVideoTracks().some((t) => t.enabled),
  };
}

function broadcastMeta() {
  for (const id of peers.keys()) send({ type: "signal", to: id, data: { meta: selfMeta() } });
}

function tileName(peer, streamId) {
  return streamId === peer.meta.screen ? `${peer.info.name} · screen` : peer.info.name;
}

// ---------- controls ----------

$("#mic").onclick = () => toggleTracks(local.getAudioTracks(), $("#mic"));
$("#cam").onclick = () => toggleTracks(local.getVideoTracks(), $("#cam"));
$("#share").onclick = () => (screen ? stopShare() : startShare());
$("#leave").onclick = () => leave("You left the session.");
$("#copy").onclick = async () => {
  await navigator.clipboard.writeText(`${location.origin}/room.html?m=${meetingId}`).catch(() => {});
  $("#copy-label").textContent = "Copied";
  setTimeout(() => ($("#copy-label").textContent = "Invite"), 1500);
};
document.addEventListener("keydown", (e) => {
  if ($("#transport").hidden || e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, select, textarea")) return;
  const key = e.key.toLowerCase();
  if (key === "m") $("#mic").click();
  else if (key === "v") $("#cam").click();
  else if (key === "s") $("#share").click();
});
for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t === tab));
    for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== tab.dataset.tab;
  };
}

// Dev-only: server exposes /dev/* only with NODE_ENV=development.
fetch("/dev/ping").then((r) => r.ok && ($("#add-bot").hidden = false)).catch(() => {});
$("#add-bot").onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  setStatus("Starting bot…");
  const res = await fetch(`/dev/meetings/${meetingId}/bots`, { method: "POST" }).catch(() => null);
  setStatus(res?.ok ? "" : "Bot failed to start");
  btn.disabled = false;
};

function toggleTracks(tracks, button) {
  if (tracks.length === 0) return setStatus("No device for that");
  for (const t of tracks) t.enabled = !t.enabled;
  const on = tracks.some((t) => t.enabled);
  button.setAttribute("aria-pressed", String(on));
  button.classList.toggle("off", !on);
  syncSelfTile();
  broadcastMeta();
}

async function startShare() {
  screen = await navigator.mediaDevices.getDisplayMedia({ video: true }).catch(() => null);
  if (!screen) return;
  const track = screen.getVideoTracks()[0];
  track.onended = stopShare; // browser's own "Stop sharing" button
  addTile("self-screen", screen, "Your screen", { muted: true, screen: true, self: true });
  $("#share").setAttribute("aria-pressed", "true");
  broadcastMeta();
  for (const peer of peers.values()) peer.screenSender = peer.pc.addTrack(track, screen);
  logEvent(`${selfName} started sharing`, true);
}

function stopShare() {
  if (!screen) return;
  for (const t of screen.getTracks()) t.stop();
  for (const peer of peers.values()) {
    if (peer.screenSender) peer.pc.removeTrack(peer.screenSender);
    peer.screenSender = null;
  }
  screen = null;
  removeTile("self-screen");
  $("#share").setAttribute("aria-pressed", "false");
  broadcastMeta();
}

function leave(reason) {
  stopShare();
  for (const id of [...peers.keys()]) removePeer(id);
  for (const t of local.getTracks()) t.stop();
  ws?.close();
  $("#transport").hidden = true;
  grid.innerHTML = "";
  $("#alone").hidden = false;
  $("#alone").innerHTML = `<div><strong>${reason}</strong></div><div class="join-row"><a class="btn" href="/">Home</a><button class="btn primary" onclick="location.reload()">Rejoin</button></div>`;
}

// ---------- tiles ----------

function addTile(key, stream, name, { muted = false, screen: isScreen = false, self = false, bot = false } = {}) {
  let tile = grid.querySelector(`[data-key="${key}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.className = "tile";
    tile.dataset.key = key;
    tile.innerHTML = `<video autoplay playsinline></video><div class="avatar"></div>
      <div class="tile-bar"><span class="tag name"></span><span class="tag muted">Muted</span>${bot ? '<span class="tag bot">Bot</span>' : ""}</div>`;
    grid.append(tile);
  }
  const video = tile.querySelector("video");
  video.muted = muted;
  video.srcObject = stream;
  tile.classList.toggle("self", self);
  setTileName(tile, name);
  setTileScreen(tile, isScreen);
  if (!isScreen && stream.getAudioTracks().length) {
    watchLevel(key, stream, (rms) => tile.classList.toggle("speaking", rms > SPEAKING_RMS && !tile.classList.contains("mic-off")));
  }
}

function setTileName(tile, name) {
  tile.querySelector(".tag.name").textContent = name;
  tile.querySelector(".avatar").textContent = name.replace(/\(you\)|·.*$/g, "").trim().slice(0, 2).toUpperCase();
}

function setTileScreen(tile, isScreen) {
  tile.classList.toggle("screen", isScreen);
  grid.classList.toggle("has-screen", !!grid.querySelector(".tile.screen"));
}

function removeTile(key) {
  grid.querySelector(`[data-key="${key}"]`)?.remove();
  levels.delete(key);
  grid.classList.toggle("has-screen", !!grid.querySelector(".tile.screen"));
}

function syncSelfTile() {
  const tile = grid.querySelector('[data-key="self"]');
  if (!tile) return;
  const m = selfMeta();
  tile.classList.toggle("mic-off", !m.mic);
  tile.classList.toggle("no-video", !m.cam);
}

function syncPeerTiles(peer) {
  for (const tile of grid.querySelectorAll(`[data-key^="${peer.info.id}:"]`)) {
    const streamId = tile.dataset.key.split(":")[1];
    const isScreen = streamId === peer.meta.screen;
    setTileName(tile, tileName(peer, streamId));
    setTileScreen(tile, isScreen);
    tile.classList.toggle("mic-off", !isScreen && peer.meta.mic === false);
    tile.classList.toggle("no-video", !isScreen && peer.meta.cam === false);
  }
}

function updateAlone() {
  $("#alone").hidden = peers.size > 0;
}

// ---------- audio levels (speaking indicator + green-room meter) ----------

function watchLevel(key, stream, onLevel) {
  if (!stream.getAudioTracks().length) return;
  audioCtx ??= new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  levels.set(key, { analyser, onLevel, buf: new Float32Array(analyser.fftSize), held: 0 });
  if (levels.size === 1) requestAnimationFrame(tickLevels);
}

function tickLevels(now) {
  for (const l of levels.values()) {
    l.analyser.getFloatTimeDomainData(l.buf);
    let sum = 0;
    for (const v of l.buf) sum += v * v;
    const rms = Math.sqrt(sum / l.buf.length);
    if (rms > SPEAKING_RMS) l.held = now;
    l.onLevel(now - l.held < 300 ? Math.max(rms, SPEAKING_RMS + 0.001) : rms); // 300 ms hold avoids flicker
  }
  if (levels.size) requestAnimationFrame(tickLevels);
}

// ---------- chrome: title, clock, recorder, timeline ----------

function renderMeeting() {
  $("#title").textContent = meeting.title;
  document.title = `${meeting.title} · Meeting Scribe`;
  $("#total").textContent = `/ ${fmt(meeting.durationMs)}`;
  renderClock();
}

function elapsedMs() {
  return meeting?.startedAt ? Math.max(0, Date.now() - meeting.startedAt) : 0;
}

function renderClock() {
  if (!meeting) return;
  const t = Math.min(elapsedMs(), meeting.durationMs);
  $("#elapsed").textContent = `T+${fmt(t)}`;
  $("#progress").style.width = `${(t / meeting.durationMs) * 100}%`;
}

function setRecorder(on) {
  $("#rec").classList.toggle("on", on);
  $("#rec").textContent = on ? "REC · Scribe" : "Scribe offline";
  $("#scribe-state").textContent = on ? "Transcribing" : "Offline";
}

function logEvent(text, system = false) {
  const li = document.createElement("li");
  li.innerHTML = `<time>${fmt(elapsedMs())}</time><span class="${system ? "sys" : ""}"></span>`;
  li.querySelector("span").textContent = text;
  $("#timeline").append(li);
}

function setStatus(text) {
  $("#status").textContent = text;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
