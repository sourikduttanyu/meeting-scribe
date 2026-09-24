// Meeting room. Media goes through the server's SFU: two RTCPeerConnections.
//   pub — we offer, server answers. Carries mic, camera, screen (each uploaded once).
//   sub — server offers, we answer. One track per remote mic/camera/screen.
// Each connection has exactly one offerer, so offers can never collide (glare).
// We tell the server which transceiver (mid) is mic/camera/screen; it tells us
// who owns each track it sends. The Scribe reads tracks inside the server.

const params = new URLSearchParams(location.search);
const meetingId = params.get("m");
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const SPEAKING_RMS = 0.02;

const $ = (s) => document.querySelector(s);
const grid = $("#grid");

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>'),
  micOff: svg('<path d="m2 2 20 20M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M18.9 13.2A7 7 0 0 0 19 10M5 10a7 7 0 0 0 12 5M12 17v5"/>'),
  cam: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>'),
  camOff: svg('<path d="m2 2 20 20M10.7 6H14a2 2 0 0 1 2 2v2.5L22 7v9.1M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/>'),
};
for (const b of document.querySelectorAll(".toggle")) {
  const k = b.dataset.kind;
  b.innerHTML = `<span class="i-on">${ICON[k]}</span><span class="i-off">${ICON[`${k}Off`]}</span>`;
  b.onclick = () => toggle(k);
}

const participants = new Map(); // id -> { name, bot, mic, cam }
let ws;
let selfId = null;
let selfName = "";
let meeting = null;
let local = new MediaStream();
let screen = null;
let pub = null; // publish PC
let sub = null; // subscribe PC
const sending = new Map(); // pub transceiver -> source
let remote = {}; // sub mid -> { id, owner, source }, from the latest subscribe-offer
const remoteTracks = new Map(); // sub mid -> track (a removed m-line's transceiver is gone by the time we look)
const streams = new Map(); // tile key -> MediaStream of received tracks
let audioCtx = null;
const want = { mic: true, cam: true }; // user intent; survives device switches and carries into the call
const levels = new Map(); // tile key -> analyser

// Exposed for e2e tests (bots read connection state and stats).
window.__room = {
  participants,
  get pub() { return pub; },
  get sub() { return sub; },
  get selfId() { return selfId; },
  get recorderPresent() { return $("#rec").classList.contains("on"); },
};

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
    $("#join-btn").disabled = true;
    $("#join-btn").textContent = "Joining…";
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
  applyWant();
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
  applyWant();
  setStatus("Connecting…");

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
      setStatus("");
      logEvent(`${selfName} joined`, true);
      for (const p of msg.peers) addParticipant(p);
      startMedia();
      break;
    case "peer-joined":
      addParticipant(msg.peer);
      logEvent(`${msg.peer.name} joined`, true);
      break;
    case "peer-left": {
      const name = participants.get(msg.id)?.name;
      removeParticipant(msg.id);
      if (name) logEvent(`${name} left`, true);
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
    case "media":
      onMedia(msg.data).catch((err) => console.error(err));
      break;
    case "ended":
      leave("Session ended — it reached its set length.");
      break;
    case "error":
      setStatus(msg.message === "meeting ended" ? "This session has ended." : `Error: ${msg.message}`);
      break;
  }
}

function media(data) {
  send({ type: "media", data });
}

// ---------- SFU connections ----------

function startMedia() {
  pub = new RTCPeerConnection({ iceServers: ICE });
  sub = new RTCPeerConnection({ iceServers: ICE });
  pub.onicecandidate = ({ candidate }) => candidate && media({ op: "candidate", pc: "pub", candidate });
  sub.onicecandidate = ({ candidate }) => candidate && media({ op: "candidate", pc: "sub", candidate });
  pub.onconnectionstatechange = sub.onconnectionstatechange = () => {
    if (pub.connectionState === "failed" || sub.connectionState === "failed") setStatus("Media connection failed");
  };
  // Browser queues negotiationneeded until the previous offer is answered.
  pub.onnegotiationneeded = async () => {
    await pub.setLocalDescription();
    const sources = {};
    for (const [t, source] of sending) if (t.mid && t.direction === "sendonly") sources[t.mid] = source;
    media({ op: "publish", sdp: pub.localDescription.sdp, sources });
  };
  sub.ontrack = ({ track, transceiver }) => {
    const info = remote[transceiver.mid];
    if (!info) return;
    remoteTracks.set(transceiver.mid, track);
    attachRemote(info, track);
  };
  const mic = local.getAudioTracks()[0];
  const cam = local.getVideoTracks()[0];
  if (mic) sending.set(pub.addTransceiver(mic, { direction: "sendonly", streams: [local] }), "mic");
  if (cam) sending.set(pub.addTransceiver(cam, { direction: "sendonly", streams: [local] }), "camera");
  if (screen) publishScreen(screen.getVideoTracks()[0]);
  sendState();
}

async function onMedia(msg) {
  if (msg.op === "publish-answer") {
    await pub.setRemoteDescription({ type: "answer", sdp: msg.sdp });
  } else if (msg.op === "subscribe-offer") {
    const before = remote;
    remote = msg.tracks; // set first: ontrack fires inside setRemoteDescription
    await sub.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    await sub.setLocalDescription();
    media({ op: "subscribe-answer", sdp: sub.localDescription.sdp });
    for (const [mid, info] of Object.entries(before)) {
      if (remote[mid]?.id === info.id) continue;
      const track = remoteTracks.get(mid);
      remoteTracks.delete(mid);
      if (track) detachRemote(info, track);
    }
  } else if (msg.op === "candidate") {
    await (msg.pc === "pub" ? pub : sub).addIceCandidate(msg.candidate);
  } else if (msg.op === "peer-state") {
    const p = participants.get(msg.id);
    if (p) Object.assign(p, { mic: msg.mic, cam: msg.cam });
    syncParticipantTile(msg.id);
  }
}

function tileKey(info) {
  return info.source === "screen" ? `${info.owner}:screen` : `${info.owner}:cam`;
}

function attachRemote(info, track) {
  const key = tileKey(info);
  const stream = streams.get(key) ?? new MediaStream();
  streams.set(key, stream);
  stream.addTrack(track);
  const p = participants.get(info.owner);
  if (info.source === "screen") {
    addTile(key, stream, `${p?.name ?? "?"} · screen`, { screen: true, bot: p?.bot });
  } else {
    const tile = addTile(key, stream, p?.name ?? "?", { bot: p?.bot });
    tile.classList.remove("connecting");
  }
  syncParticipantTile(info.owner);
}

function detachRemote(info, track) {
  const key = tileKey(info);
  streams.get(key)?.removeTrack(track);
  if (info.source === "screen") {
    streams.delete(key);
    removeTile(key);
  }
  syncParticipantTile(info.owner);
}

function publishScreen(track) {
  sending.set(pub.addTransceiver(track, { direction: "sendonly", streams: [screen] }), "screen");
}

function sendState() {
  media({ op: "state", mic: local.getAudioTracks().some((t) => t.enabled), cam: local.getVideoTracks().some((t) => t.enabled) });
}

function addParticipant(p) {
  participants.set(p.id, { name: p.name, bot: p.bot, mic: true, cam: true });
  // Placeholder until the first track lands, so a join is visible immediately.
  addTile(`${p.id}:cam`, null, p.name, { bot: p.bot }).classList.add("connecting", "no-video");
  updateAlone();
}

function removeParticipant(id) {
  participants.delete(id);
  for (const key of [`${id}:cam`, `${id}:screen`]) {
    streams.delete(key);
    removeTile(key);
  }
  updateAlone();
}

// ---------- controls ----------

$("#share").onclick = () => (screen ? stopShare() : startShare());
$("#leave").onclick = () => leave("You left the session.");
$("#copy").onclick = async () => {
  await navigator.clipboard.writeText(`${location.origin}/room.html?m=${meetingId}`).catch(() => {});
  $("#copy-label").textContent = "Copied";
  setTimeout(() => ($("#copy-label").textContent = "Invite"), 1500);
};
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, select, textarea")) return;
  const key = e.key.toLowerCase();
  if (key === "m") toggle("mic");
  else if (key === "v") toggle("cam");
  if ($("#transport").hidden) return; // rest is in-call only
  if (key === "s") $("#share").click();
  else if (key === "i") document.body.classList.toggle("show-stats");
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

function toggle(kind) {
  want[kind] = !want[kind];
  applyWant();
  if (pub) sendState();
}

// Mute = track.enabled=false: the sender keeps the m-line and sends silence /
// black frames, so unmute is instant with no renegotiation.
function applyWant() {
  const has = { mic: local.getAudioTracks().length > 0, cam: local.getVideoTracks().length > 0 };
  for (const t of local.getAudioTracks()) t.enabled = want.mic;
  for (const t of local.getVideoTracks()) t.enabled = want.cam;
  for (const b of document.querySelectorAll(".toggle")) {
    const k = b.dataset.kind;
    const on = has[k] && want[k];
    const label = k === "mic" ? (on ? "Mute" : "Unmute") : on ? "Turn camera off" : "Turn camera on";
    b.classList.toggle("off", !on);
    b.disabled = !has[k];
    b.dataset.tip = has[k] ? `${label} · ${k === "mic" ? "M" : "V"}` : `No ${k === "mic" ? "microphone" : "camera"}`;
    b.setAttribute("aria-label", b.dataset.tip);
  }
  $("#preview-empty").hidden = has.cam && want.cam;
  syncSelfTile();
}

async function startShare() {
  screen = await navigator.mediaDevices.getDisplayMedia({ video: true }).catch(() => null);
  if (!screen) return;
  const track = screen.getVideoTracks()[0];
  track.onended = stopShare; // browser's own "Stop sharing" button
  addTile("self-screen", screen, "Your screen", { muted: true, screen: true, self: true });
  $("#share").setAttribute("aria-pressed", "true");
  if (pub) publishScreen(track);
  logEvent(`${selfName} started sharing`, true);
}

function stopShare() {
  if (!screen) return;
  for (const t of screen.getTracks()) t.stop();
  const t = [...sending].find(([, source]) => source === "screen")?.[0];
  if (t && pub?.signalingState !== "closed") {
    t.sender.replaceTrack(null);
    t.direction = "inactive"; // → negotiationneeded; the server unpublishes it and rejects the m-line
    sending.delete(t); // a rejected transceiver is stopped; re-share gets a fresh one (Chrome recycles the m-line)
  }
  screen = null;
  removeTile("self-screen");
  $("#share").setAttribute("aria-pressed", "false");
}

function leave(reason) {
  stopShare();
  pub?.close();
  sub?.close();
  for (const id of [...participants.keys()]) removeParticipant(id);
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
    tile.innerHTML = `<video autoplay playsinline></video><div class="avatar"></div><div class="stats"></div>
      <div class="tile-bar"><span class="tag muted" aria-label="Muted">${ICON.micOff}</span><span class="tag name"></span>${bot ? '<span class="tag bot">Bot</span>' : ""}</div>`;
    grid.append(tile);
  }
  const video = tile.querySelector("video");
  video.muted = muted;
  video.srcObject = stream;
  tile.classList.toggle("self", self);
  setTileName(tile, name);
  setTileScreen(tile, isScreen);
  if (stream && !isScreen && stream.getAudioTracks().length) {
    watchLevel(key, stream, (rms) => tile.classList.toggle("speaking", rms > SPEAKING_RMS && !tile.classList.contains("mic-off")));
  }
  return tile;
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
  tile.classList.toggle("mic-off", !local.getAudioTracks().some((t) => t.enabled));
  tile.classList.toggle("no-video", !local.getVideoTracks().some((t) => t.enabled));
}

function syncParticipantTile(id) {
  const tile = grid.querySelector(`[data-key="${id}:cam"]`);
  const p = participants.get(id);
  if (!tile || !p || tile.classList.contains("connecting")) return;
  const hasVideo = (streams.get(`${id}:cam`)?.getVideoTracks().length ?? 0) > 0;
  tile.classList.toggle("mic-off", p.mic === false);
  tile.classList.toggle("no-video", p.cam === false || !hasVideo);
}

// ---------- connection stats (hover a tile or press I) ----------
// All remote media arrives on `sub`, so one getStats() covers every tile;
// inbound-rtp.trackIdentifier matches the receiver track id in each tile.

const prevBytes = new Map(); // inbound-rtp id -> { bytes, ts }
setInterval(async () => {
  if (sub?.connectionState !== "connected") return;
  const report = await sub.getStats();
  let rtt = null;
  const inbound = new Map(); // track id -> stats
  for (const s of report.values()) {
    if (s.type === "candidate-pair" && s.nominated && s.currentRoundTripTime != null) rtt = s.currentRoundTripTime * 1000;
    if (s.type !== "inbound-rtp") continue;
    const prev = prevBytes.get(s.id);
    prevBytes.set(s.id, { bytes: s.bytesReceived, ts: s.timestamp });
    const kbps = prev ? ((s.bytesReceived - prev.bytes) * 8) / (s.timestamp - prev.ts) : 0;
    const codec = report.get(s.codecId)?.mimeType?.split("/")[1] ?? "";
    inbound.set(s.trackIdentifier, { kbps, codec, h: s.frameHeight, fps: s.framesPerSecond, lost: s.packetsLost, jitter: (s.jitter ?? 0) * 1000 });
  }
  for (const [key, stream] of streams) {
    const tile = grid.querySelector(`[data-key="${key}"]`);
    if (!tile) continue;
    const v = inbound.get(stream.getVideoTracks()[0]?.id);
    const a = inbound.get(stream.getAudioTracks()[0]?.id);
    const lines = [];
    if (rtt != null) lines.push(`rtt   ${rtt.toFixed(0)} ms (sfu)`);
    if (v) lines.push(`video ${v.codec} ${v.h ?? "-"}p${v.fps ? ` ${v.fps.toFixed(0)}fps` : ""} ${(v.kbps / 1000).toFixed(2)} Mbps`);
    if (a) lines.push(`audio ${a.codec} ${a.kbps.toFixed(0)} kbps · jitter ${a.jitter.toFixed(0)} ms`);
    lines.push(`lost  ${(v?.lost ?? 0) + (a?.lost ?? 0)} pkts`);
    tile.querySelector(".stats").textContent = lines.join("\n");
  }
}, 1000);

function updateAlone() {
  $("#alone").hidden = participants.size > 0;
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
  $("#progress").style.transform = `scaleX(${t / meeting.durationMs})`;
}

function setRecorder(on) {
  $("#rec").classList.toggle("on", on);
  $("#rec").textContent = on ? "Scribe on" : "Scribe off";
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
