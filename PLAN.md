# Plan

## Problem

Two (later N) people in a video call with camera, mic, and screen share. The system builds a live, timestamped understanding of the meeting so that a late joiner can ask:
- "What has happened so far?"
- "What happened in the first 5 minutes?"
- "Summarize the first half." (meetings have a fixed duration)
- "What did A say about the budget?"

Target: "pseudo-realtime" — captions ≤ ~2s after an utterance ends, summaries ≤ ~60s stale. $0 to run as a POC.

## Status

| Phase | State |
|---|---|
| 0. Machine setup | ✅ done |
| 1. Scaffold + core | ✅ done |
| 1.5 Test harness (scenarios, TTS, L0 bot) | ✅ done |
| 2. Call + signaling | ✅ done |
| 2.1 UI/UX overhaul | ✅ done |
| 3. Scribe ingest (audio + share state) | ✅ done |
| 4. Live captions | ⬜ |
| 5. Summaries + Q&A | ⬜ |
| 6. Screen understanding | ⬜ |
| 7. MCP server | ⬜ |
| 8. Interactive AI participant | ⬜ |

## Phases

### 0. Machine setup ✅
- whisper-cpp 1.9.4 (Homebrew), `models/ggml-small.en.bin`, Ollama with `qwen2.5:7b`, ffmpeg.
- Verified: whisper-cli transcribed a `say`-generated clip exactly; qwen2.5 summarized it. Cold start ~17s (whisper) / ~22s (LLM) — servers must stay warm.

### 1. Scaffold + core ✅
- Node 25 runs `.ts` directly (type stripping) — no build step; `tsc` (TS 7) only typechecks. Tests on `node:test`, storage on built-in `node:sqlite`. Zero runtime dependencies.
- `core/types.ts` (contracts), `core/topics.ts` (NATS-style `*` / `>` matching), `core/log.ts` (SQLite append-only log, WAL), `core/pipeline.ts` (bus + plugin host: per-plugin FIFO queues, drop policies, meeting-scoped ctx, no self-delivery, error isolation, `drain()`, `stats()`).
- **Verify:** ✅ `npm run check` — 11 tests: ordered delivery, derived events logged, time-range slicing, loop prevention, meeting isolation, non-durable events, `oldest`/`never` policies, throwing plugin isolation, unknown meeting rejected.

**Critique**
- *Doc correction:* planned a `block` drop policy; an in-process `publish` can't block without making every producer async. Shipped `never` (never drop, warn over max). True backpressure needs a pull-based broker.
- *No delivery guarantee across crashes.* Log is written before dispatch, but there are no consumer offsets — if the process dies mid-queue, those plugin deliveries are lost and nothing resumes them. At scale: consumer groups with committed offsets (Kafka/Redis Streams) → at-least-once, and handlers made idempotent via `event.id`.
- *Serial per plugin = latency stacks.* Two speakers' utterances wait in one STT queue. Fix later: concurrency per partition key `(meetingId, source)` — ordered per speaker, parallel across speakers. Same reasoning as choosing a Kafka partition key.
- *`never` = unbounded memory.* Sustained STT lag → OOM. Needs `stats()` exported as a metric + alert/autoscale on queue depth.
- *Sync SQLite insert on the publish hot path.* Fine at POC rates (a few events/s per meeting once `audio.pcm` is non-durable); at scale batch writes or hand off to the broker.
- *Topic filter runs in JS* after the SQL time-range scan. OK for one meeting (~10k events / 2h); add a topic index or materialized views (e.g. transcript-only table) if Q&A queries get hot.
- *No event schema version.* `data` shape will evolve; add `v` to events before anything is persisted long-term.
- Meeting cache in `Pipeline` never evicts — fine for POC, leak on a long-running server.

**Interview Q&A**
- *Why an event log instead of plugins writing their own tables?* Single source of truth, replay (a new "action items" plugin can run over last month's meetings), audit/debugging. Cost: storage and schema evolution.
- *How do you keep one bad plugin from taking down the pipeline?* Isolated queue per plugin, errors caught per event, drop policy chosen per data type (freshness vs completeness). Out-of-process workers next.
- *Why is `ctx` bound to a meeting?* Tenant isolation by construction, and it makes `meetingId` the natural partition key for scaling out.

### 1.5 Test harness ✅
- `scenarios/*.json`: participants (with `say` voices), timed script (`say` / `screen` / `join` / `leave`), and Q&A `checks` (`mustMention` / `mustNotMention`).
- `testing/scenario.ts` (types + validation, no deps), `testing/tts.ts` (`say` → 16 kHz mono PCM16 WAV, hash-cached), `testing/l0-bot.ts` (publishes what ASR/OCR would emit, at scenario time).
- `npm run scenario -- <file>`: validate → render voices → L0 replay into `data/<name>.sqlite` → print timeline.
- Sample `budget-review.json`: 3 speakers (US/GB/IN accents), late joiner at 1:30, slide at 0:45, a decision, action items.
- **Verify:** ✅ 15 tests; a 4-min meeting replays in ~2 ms; first-minute query returns exactly the 6 first-minute utterances; WAV header checked (RIFF, mono, 16 kHz, 16-bit, 44-byte header); second render is a cache hit.

**Critique**
- *Event contracts are defined by the fake before the real thing exists.* Good (phase 4 has a target), but risk: the real ASR naturally produces something different (e.g. segments split mid-sentence). Contract may need to change — fine, bots are the cheapest place to change it.
- *L0 `endT` defaults to a 150 wpm estimate;* the CLI uses real rendered durations. Tests using the estimate are only approximately right for anything duration-sensitive.
- *No overlap detection.* A line can be scripted to start before the previous speaker's audio ends. Useful on purpose (overlap tests) but silent by accident — validation should warn when rendered audio overlaps unintentionally.
- *`say` voices are clean, studio-level audio* → optimistic WER. Mix noise at L1; benchmark on the AMI Meeting Corpus later.
- *macOS-only TTS.* CI on Linux needs Piper or committed WAV fixtures; the TTS test self-skips off macOS.
- *Keyword checks are brittle to paraphrase* ("$10k" vs "ten thousand"). Add an LLM judge in phase 5, still anchored by keywords.

**Interview Q&A**
- *How do you test a nondeterministic AI pipeline?* Scripted scenarios with ground truth; deterministic replay below the model layer (L0/L1); metrics (WER, latency, attribution, Q&A checks) tracked per commit instead of pass/fail only.
- *Why event time instead of wall clock?* Replayability and testability — the same reason stream processors (Flink, Kafka Streams) separate event time from processing time. A 2h meeting becomes a 2 ms test.
- *Why a test pyramid of bots?* Cost vs fidelity: most coverage at L0/L1 (instant, deterministic), a thin layer of real-time L2/L3 end-to-end runs.

### 2. Call + signaling ✅
- `server/signaling.ts`: rooms, roles, relay — pure logic over an injected `Transport` (testable without sockets). `server/app.ts`: HTTP (static, `POST/GET /api/meetings`), `ws` at `/ws`, meeting end timers, dev routes. `server/main.ts`: entry.
- Recorder is never in `peers` / `peer-joined`, but announced as `recorder` / `recorder-joined` → the "AI notes on" banner reflects whether a recorder is actually present.
- Signaling emits `presence.join/leave` (`{name, bot}`) into the pipeline at `t = now - startedAt` — same contract as the L0 bot.
- `web/room.js`: P2P mesh, **perfect negotiation** (polite = lower id), camera/screen labelled via `{meta: {camera, screen}}` stream ids, mic/cam toggles, countdown to fixed end.
- L3 bot (`testing/l3-bot.ts`): installed Chrome via playwright-core, fake camera + rendered WAV as mic. Dev "+ Add test bot" button → `POST /dev/meetings/:id/bots` (only with `NODE_ENV=development`).
- **Verify:** ✅ 19 unit/integration tests (signaling over real WS: join, relay, hidden recorder, leave, presence, errors, path traversal). ✅ `npm run e2e:call`: two Chrome bots connect in ~2 s with audio+video bytes flowing, recorder joins → banner on and still 1 peer, mid-call screen share renegotiates (tile added) and stop removes it, presence logged.

**Critique**
- *Mesh doesn't scale:* each client uploads N-1 copies. Fine for 2–4; SFU is the fix (already on the scale path).
- *No TURN.* Only STUN → calls fail behind symmetric NAT / strict corporate firewalls (commonly cited ~10–20% of real users). Fix: coturn or a managed TURN; test by forcing `iceTransportPolicy: "relay"`.
- *No auth.* Anyone with the 8-hex meeting id (32 bits) can join, including as `role: "recorder"`. Fix: signed join tokens (JWT with meetingId + role), recorder role only issuable by the server.
- *Signaling is in-memory, single process.* Can't scale horizontally as is. Fix: route by `meetingId` (consistent hashing / sticky) so a room lives on one node, or Redis pub/sub for cross-node relay.
- ~~*`startedAt` = creation time*~~ → **fixed:** clock starts at the first *participant* join (a recorder joining early doesn't start it); end timer set then. E2E: first join now at t≈1 ms (was ~4.5 s). Remaining gap: a meeting nobody ever joins never expires — needs a creation-time TTL.
- *End timers live in memory;* a restart forgets them (joins after end are still rejected by the `startedAt + durationMs` check, but connected users aren't kicked).
- *Client is plain JS* duplicating protocol types → drift risk. Cheap fix: `// @ts-check` + JSDoc `import("../server/signaling.ts")` types so `tsc` checks the browser code too.
- *L3 e2e is timing-based* (polls with timeouts) → potential flakiness on a loaded machine.

**Interview Q&A**
- *What is glare and how do you handle it?* Both peers send offers at once (common on renegotiation). Perfect negotiation: one side is "polite" (rolls back its own offer and accepts the other), the impolite one ignores the incoming offer. Roles are decided deterministically (id comparison), so no extra round trip.
- *Why P2P first, SFU later?* P2P = no media server, lowest latency, $0 — ideal for 2 people. Upload grows O(N) per client and total streams grow O(N²), so past ~4 people an SFU (each client uploads once; server forwards) wins. Our recorder is already a "subscriber" in shape, which maps directly onto SFU egress.
- *How would you scale signaling to millions of users?* Signaling is cheap (a few KB per join); the constraint is room locality. Shard by `meetingId` so each room lives on one node; stateless edge WS gateways + a pub/sub backbone for relays; presence in Redis with TTLs.
- *How is the hidden recorder still consent-compliant?* It's hidden from the video grid, not from users — clients are told a recorder exists and show a banner driven by its actual presence.

### 2.1 UI/UX overhaul ✅
- Identity: hybrid of portfolio (deep navy, signal teal, ops vocabulary) + JellySynth (chassis vs LCD display surfaces, Doto for readouts only, one signal color, OKLCH ramps with constant hue). Tokens + rules at the top of `web/style.css`.
- Landing: new session with length presets + join by code/link. Green room: camera preview, mic level meter, device pickers, consent line. Console room: top bar (session, REC·Scribe indicator, `T+` elapsed / length on LCD, progress bar = meeting timeline, invite copy), stage (speaking outline, muted tag, initials when camera off, screen share takes the stage), Scribe panel (Live / Timeline / Ask — Timeline already logs joins/leaves/shares; Live & Ask wait for phases 4–5), transport (Mic/Camera/Share with M/V/S shortcuts, Add bot in dev, Leave).
- Mic/cam state now travels in `meta` so peers render MUTED / camera-off correctly.
- **Verify:** ✅ `npm run e2e:call` still passes; screenshots of landing, green room, in-call (1440×900) and mobile checked.

- Restraint pass: Geist / Geist Mono (tabular numbers), sentence-case labels, no pulsing or badges, off-white primary; teal only on live dots and the speaking outline; centered icon transport. Motion = opacity/transform/color, 120–200 ms.
- **Live WebRTC stats** per tile (hover or `I`): RTT, codec, resolution, fps, bitrate, audio jitter, packet loss — stats matched to tiles by `inbound-rtp.trackIdentifier`.

**Bug found by the redesign: initial-connect glare lost ICE candidates (e2e ~40% pass → 8/8).**
The new join path shifted timing so both peers created their connection simultaneously. Both offered; perfect negotiation made the impolite side ignore the other's offer — and, by design, silently drop the ICE candidates trickled for it. Gathering had already completed, so nothing new arrived: `stable / complete / new / new` forever. Diagnosed by adding signaling/ICE state to the e2e failure output. Fix: the newcomer is the only initial offerer; the existing peer adds its tracks when that offer lands (they reuse the offer's transceivers and ride on the answer). Perfect negotiation remains for later renegotiation.
*Interview Q: "Perfect negotiation handles glare — so why did you still get stuck connections?"* → the candidate-drop interaction above; mitigations: avoid initial glare, or ICE-restart when `iceConnectionState` stays `new` after the answer.

**Critique**
- Speaking detection is client-side RMS with a fixed threshold → noisy rooms light up constantly. Better: use the server VAD (phase 4) and broadcast `speaking` events.
- The Timeline panel is client-local (built from signaling events), so a late joiner's timeline starts empty. Phase 5 replaces it with the server event log — the real product.
- Google Fonts is an external dependency for an otherwise self-contained app; self-host the two fonts for offline demos.

### 3. Scribe ingest (audio + share state) ✅
- `ingest/scribe.ts`: werift peer; each client opens a `sendonly` PeerConnection to it on join (mic + screen when sharing).
- Opus RTP → decode (`@discordjs/opus`) → 48k→16k mono PCM16 → `audio.pcm` per speaker.
- **Share state as events, not absence.** Scribe emits durable `screen.share.start {by}` / `screen.share.stop {by}` when a screen track actually starts or stops producing RTP. The source of truth is the media the Scribe received, not what the client claims. Q&A then answers "was anything shared in the first 10 min?" from intervals ("nothing shared 0:00–4:12, Alice shared 4:12–9:30").
- **Coverage events.** `scribe.online` / `scribe.offline` (durable). This separates "nothing happened" from "Scribe wasn't listening", so Q&A can say "I wasn't recording 2:00–3:10" instead of inventing a quiet stretch.
- **Identity is bound at join, not guessed from audio.** Signaling assigns `participantId` + name on join. That participant's sendonly PeerConnection to the Scribe carries only their tracks, so every RTP packet on it is theirs. `audio.pcm` / `transcript.final` get `source = participantId`. Two people talking at once = two tracks = two transcripts, no diarization. (Names are self-declared until auth lands. See the phase 2 critique.)
- **Active speaker from RTP audio-level, no decoding.** Browsers stamp every Opus packet with the RFC 6464 `ssrc-audio-level` header extension (dBov). Scribe keeps a ~300ms smoothed level per participant. The loudest one above a speech threshold, held for ≥500ms (hysteresis stops flapping), is the active speaker. It emits durable `speaker.active {id}` only on change. The same signal SFUs use for dominant-speaker switching, and it costs nothing to compute.
- **"Now" state = projection of the log.** Scribe folds `presence.*`, `screen.share.*`, `speaker.active` and `scribe.*` into a live per-meeting snapshot: `{ participants, sharing: {by} | null, speaking: id | null, scribeOnline }`. `GET /api/meetings/:id/now` returns it, and the room UI and Q&A ("who is presenting right now?") read it. Replaying the log rebuilds the same snapshot at any past `t` ("who was sharing at 12:00?").
- The screen track is received and its state tracked here. Decoding frames is phase 6.
- **Verify:** after a 30s call, `data/<meeting>/<speaker>.wav` plays back clean for each participant, with correct duration. Share → stop yields exactly one start/stop pair, with `t` within 1s of the click. Killing the Scribe mid-call leaves an `offline`/`online` gap in the log. Two L3 bots speaking in turns produce alternating `speaker.active` events that match the script's turn boundaries within ~1s. `/now` reflects share and speaker changes within ~1s.

**Built:** `ingest/scribe.ts` (werift, joins via the same signaling protocol over an in-process transport), `plugins/active-speaker.ts`, `plugins/wav-dump.ts`, `core/now.ts` + `GET /api/meetings/:id/now[?t=]`, client uplink in `room.js`. Verify: `npm run e2e:scribe` (two Chrome bots take turns via the real mute button while one shares).

**Verified (3/3 runs):** Scribe online and both uplinks connected. Speaker state from `/now?t=` replay matches the script every 500ms inside every turn. Switch stamped ~80–130ms after the mute click. One share start/stop pair, each within 1s of the click, visible in `/now` within ~250ms (the poll interval). Per-speaker WAVs span the meeting from t=0: RMS ~3–5k in the speaker's own turn, exactly 0 in the other's. whisper.cpp transcribes both WAVs almost verbatim. Opus decode (opusscript/WASM) costs 15µs per 20ms packet, ≈0.08% of a core per speaker.

**Bugs found on the way:**
- werift gathers ICE during `setLocalDescription`, so candidates went out *before* the answer and Chrome rejected them (`remote description was null`). The Scribe now holds candidates until its answer is sent.
- `pipeline.use()` is async and wasn't awaited, so the plugin registered after the first events.
- A symmetric 300ms smoothing stamped speaker switches ~420ms late, because the new speaker had to climb past the speech threshold. Switched to fast attack (50ms) and slow release (300ms), the standard level-meter shape.

#### Critique
- **Double upload.** Every client uploads its mic twice: once to each peer, once to the Scribe. Fine for 2–4 people, wrong at scale. *At scale:* an SFU receives each track once, and the Scribe subscribes to the SFU (LiveKit egress / track subscription). Clients stop knowing the Scribe exists at the media level.
- **Scribe runs on the signaling server's event loop.** werift's SRTP/DTLS is pure JS. Decode is cheap (measured) but crypto isn't free, and a busy meeting could add latency to signaling. *Next:* same class, own process. The in-process transport was built so this is just swapping in a WebSocket transport.
- **No jitter buffer or loss concealment.** Packets are decoded in arrival order, and a lost packet becomes 20ms of silence. OK on localhost/LAN, audible on real networks. *Fix:* a ~60ms reorder buffer by sequence number, and Opus PLC/FEC (decode with a null packet or with the next packet's FEC data).
- **Capture time is approximate.** `t` is the RTP timestamp anchored to our clock at the first packet, so it carries that packet's one-way network delay, and different speakers may have different delays. *Proper:* map RTP time to sender NTP time via RTCP Sender Reports, plus a per-client clock offset. Matters for overlapping speech ordering, not for "first 5 minutes".
- **Crash leaves no `scribe.offline`.** A graceful close emits it; a crash doesn't, so the log claims the Scribe was online through the gap. *Fix:* on boot, close any meeting whose last `scribe.*` event is `online` with a synthetic `offline` at the last event's `t`. Or emit heartbeats and treat missing ones as a gap.
- **Audio level is reported by the sender.** A modified client could claim to be loud and steal the spotlight. Attribution isn't affected (transcripts come from each person's own track), only the active-speaker label. *Hardening:* compute the level server-side from the PCM we decode anyway.
- **Share stop trusts the client's claim.** Start needs claim *and* media; stop needs only the claim (static screens can legitimately pause RTP). A client that stops sending but keeps claiming stays "sharing". A crash is handled by `peer-left`.
- **Per-meeting plugin state is never evicted** (active-speaker's map). Needs a `meeting.ended` event. *At scale:* partition-local state dropped when a meetingId's partition moves.
- **`/now` folds the whole log per request.** O(events). *At scale:* a materialized snapshot per meeting updated on each durable event, periodically checkpointed, and replay from the checkpoint for `?t=` queries.
- **`audio.pcm` is one bus event per 20ms packet.** 50/s per speaker is fine in-process. At scale, batch into 100–200ms frames, or keep PCM out of the bus (per-speaker ring buffer) and publish references.
- **L2 (werift client) bot not built.** The L3 Chrome bots exercise the real browser path, which matters more. L2 becomes worth it for fast CI and for load tests (hundreds of fake speakers without hundreds of Chromes).

**Interview Q:** *"How do you know who said what without speaker diarization?"* → Identity is structural. Each participant's media arrives on their own PeerConnection, created after they authenticated to signaling, so every packet is already labelled. Overlapping speech is two tracks, transcribed separately. Diarization is only needed where people share one mic (a conference room), and then only within that track.

**Interview Q:** *"How do you pick the active speaker, and why not from the audio itself?"* → Browsers already put a per-packet level in an RTP header extension (RFC 6464). Reading it costs nothing, needs no decoding, and is what SFUs use for dominant-speaker switching. I smooth it with fast attack / slow release, require a new speaker to win for 500ms (hysteresis), and only log changes. Downside: the sender computes the level, so it's spoofable. Server-side RMS from the decoded PCM is the hardened version.

**Interview Q:** *"Why timestamp from RTP time instead of arrival time?"* → Arrival time includes jitter: packets bunch up and spread out on the network, so arrival-based timestamps smear and reorder speech. RTP timestamps come from the sender's sample clock, so spacing is exact. I anchor once to our clock and re-anchor if they drift more than 500ms apart. The rigorous version uses RTCP Sender Reports to map to sender wall-clock time.


### 4. Live captions
- `plugins/vad.ts`: energy VAD, 20ms frames, ~600ms hangover, 15s cap → `audio.utterance`.
- `providers/stt/whisper-cpp.ts` → `whisper-server` HTTP; `plugins/transcribe.ts` → `transcript.final`.
- Captions pushed to room UI.
- **Verify:** spoken sentences appear as captions with the right speaker name within ~2s; measure and record warm latency here.

### 5. Summaries + Q&A
- `plugins/summarizer.ts`: 60s chunk summaries → `summary.chunk`; 10-min rollups.
- `plugins/qa.ts`: parse time range from question (relative to `startedAt` / `durationMs`) → gather summaries + raw transcript in range → LLM answer.
- Late-joiner "Catch me up" panel.
- **Verify:** scripted 5-min meeting (TTS audio) → "what happened in the first 2 minutes?" answer only mentions content from 0–120s.

### 6. Screen understanding
- Scribe: VP8 → ffmpeg → 1fps JPEG (PLI on share start for a keyframe); dHash change detection → `screen.frame` only on change. Frames only flow between `screen.share.start` and `stop` (phase 3).
- `plugins/screen-ocr.ts` (Tesseract) → `screen.text`; optional Gemini Live vision provider.
- **Verify:** switching slides during share produces one `screen.text` event per slide, with readable text.

### 7. MCP server
- Expose `list_meetings`, `get_timeline(meetingId, from, to)`, `ask(meetingId, question)` over MCP, reusing the Q&A plugin.
- **Verify:** Claude Code connects to it and answers a question about a stored meeting.

### 8. Interactive AI participant
- An LLM-driven bot that joins as a (visible, labelled) participant: listens via the pipeline (`transcript.final`), decides when it is addressed, replies with TTS audio over its own WebRTC track.
- Reuses the L2 bot's WebRTC client + the Q&A plugin. Demo feature, not a testing tool.
- **Verify:** "Scribe, what did Bob say about marketing?" spoken in a call → spoken answer within ~5 s.

## Scale path

| Component | POC | ~1k concurrent meetings | ~1M users |
|---|---|---|---|
| Media | P2P mesh + Scribe peer | SFU (LiveKit/mediasoup); Scribe = server-side subscriber, clients upload once | Geo-distributed cascading SFUs, TURN fleet |
| Ingest | werift in main process | Scribe workers scheduled per meeting | Per-region worker pools, autoscaled |
| Bus | In-process EventEmitter | Redis Streams / NATS, stream per meeting | Kafka partitioned by `meetingId` |
| Plugins | Same process | Stateless worker pools per topic, scale on queue lag | GPU pools, batched inference (vLLM/Triton) |
| Log / storage | SQLite + local files | Postgres partitioned by meeting; blobs in S3/R2 | ClickHouse/Scylla timeline; Qdrant/pgvector for RAG |
| STT / LLM | whisper.cpp + Ollama local | Hybrid local GPU + API fallback (Deepgram/AssemblyAI) | Cost per meeting-minute as the key metric; per-tenant provider choice |
| Q&A | Time filter + LLM | Hierarchical summaries + embeddings, cached | Summaries immutable once chunk closes → aggressive caching |

## Decisions

| Decision | Why | At scale |
|---|---|---|
| Server-side hidden Scribe peer, not client-side capture | Works with any WebRTC client, server sees real media, grows into SFU egress | SFU subscriber; clients stop double-uploading |
| Record per-speaker tracks before mixing | Speaker attribution free, no diarization | Same; diarization only for shared-room mics |
| Identity = signaling join → that participant's PeerConnection | Attribution is structural, not inferred; overlapping speech stays separate | Signed JWT identity per join; SFU keeps participant ↔ track mapping |
| Active speaker from RTP `ssrc-audio-level`, emitted on change | Zero decode cost; change-only events keep the log small | Exactly how SFUs (LiveKit, Jitsi) pick dominant speaker |
| "Now" state is a projection of the event log | One source of truth; any past moment reconstructable by replay | Materialized view per meetingId (Redis hash), rebuilt from the stream on failover |
| Capture-time timestamps | Timeline correct even when ASR/network lags | Same; NTP-style clock offset per client |
| Event bus + append-only log | Plugins decoupled; new plugins replay old meetings | Log becomes Kafka/Redis Streams |
| VAD → whole-utterance Whisper | Whisper is not streaming; utterances give best accuracy, skip silence (~40% compute saved) | Streaming STT provider for partial captions |
| Provider adapters for STT/LLM/Vision | Vendor swap is a config change | Per-tenant cost/latency choice |
| werift (pure TS WebRTC) | No native build issues on M4, debuggable | node-datachannel or SFU-native if CPU bound |
| opusscript (libopus → WASM) over @discordjs/opus | Native binding has no Node 25 prebuild and failed to compile; WASM decodes at 15µs/packet, decoding straight to 16 kHz (no resampler) | Native libopus in a media worker, or let the SFU/STT provider take Opus directly |
| Scribe answers, never offers | Glare impossible on the uplink by construction | Same pattern for any server-side media consumer |
| Recorder hidden from grid, visible as indicator | Consent laws (two-party consent, GDPR, DPDP) | Same, plus audit log |

## Open questions

- Partial (in-progress) captions: worth a streaming STT plugin later?
- Camera video: any analysis at all, or ignore?
- Q&A retrieval: when do time-range summaries stop being enough and embeddings become necessary?

## Alternatives considered

- Meeting-bot APIs (Recall.ai, Meeting BaaS, Attendee, Vexa) — solve joining *other* platforms' meetings; we own the platform.
- Frameworks with same pattern: LiveKit Agents, Pipecat — study for reference; possible migration target.
- Gemini Live API — streaming audio+video multimodal, free tier; candidate vision provider for screen share.
