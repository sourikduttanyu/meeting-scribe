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
| 3. Scribe ingest (audio) | ⬜ |
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

### 3. Scribe ingest (audio)
- `ingest/scribe.ts`: werift peer; each client opens a `sendonly` PeerConnection to it on join.
- Opus RTP → decode (`@discordjs/opus`) → 48k→16k mono PCM16 → `audio.pcm` per speaker.
- **Verify:** after a 30s call, `data/<meeting>/<speaker>.wav` plays back clean for each participant, with correct duration.

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
- Scribe: VP8 → ffmpeg → 1fps JPEG; dHash change detection → `screen.frame` only on change.
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
| Capture-time timestamps | Timeline correct even when ASR/network lags | Same; NTP-style clock offset per client |
| Event bus + append-only log | Plugins decoupled; new plugins replay old meetings | Log becomes Kafka/Redis Streams |
| VAD → whole-utterance Whisper | Whisper is not streaming; utterances give best accuracy, skip silence (~40% compute saved) | Streaming STT provider for partial captions |
| Provider adapters for STT/LLM/Vision | Vendor swap is a config change | Per-tenant cost/latency choice |
| werift (pure TS WebRTC) | No native build issues on M4, debuggable | node-datachannel or SFU-native if CPU bound |
| Recorder hidden from grid, visible as indicator | Consent laws (two-party consent, GDPR, DPDP) | Same, plus audit log |

## Open questions

- Partial (in-progress) captions: worth a streaming STT plugin later?
- Camera video: any analysis at all, or ignore?
- Q&A retrieval: when do time-range summaries stop being enough and embeddings become necessary?

## Alternatives considered

- Meeting-bot APIs (Recall.ai, Meeting BaaS, Attendee, Vexa) — solve joining *other* platforms' meetings; we own the platform.
- Frameworks with same pattern: LiveKit Agents, Pipecat — study for reference; possible migration target.
- Gemini Live API — streaming audio+video multimodal, free tier; candidate vision provider for screen share.
