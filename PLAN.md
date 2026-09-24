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
| 1. Scaffold + core | ⬜ |
| 2. Call + signaling | ⬜ |
| 3. Scribe ingest (audio) | ⬜ |
| 4. Live captions | ⬜ |
| 5. Summaries + Q&A | ⬜ |
| 6. Screen understanding | ⬜ |
| 7. MCP server | ⬜ |

## Phases

### 0. Machine setup ✅
- whisper-cpp 1.9.4 (Homebrew), `models/ggml-small.en.bin`, Ollama with `qwen2.5:7b`, ffmpeg.
- Verified: whisper-cli transcribed a `say`-generated clip exactly; qwen2.5 summarized it. Cold start ~17s (whisper) / ~22s (LLM) — servers must stay warm.

### 1. Scaffold + core
- Node/TS ESM project: `server/{core,ingest,plugins,providers}`, `web/`, `plugins.config.json`.
- `core/bus.ts` (topic pub/sub with glob match), `core/log.ts` (SQLite append-only events), `core/plugin-host.ts` (per-plugin queues + drop policies), `core/types.ts`.
- **Verify:** unit test — a dummy plugin subscribed to `test.*` receives events in order, emits a derived event, and it lands in the log; `query({from,to})` returns the right slice.

### 2. Call + signaling
- WebSocket signaling server; rooms with `meetingId`, `startedAt`, `durationMs`; roles `participant | recorder`.
- `web/room.html`: P2P camera + mic + screen share; "AI notes on" banner.
- **Verify:** two browser tabs connect, see/hear each other, screen share works; recorder role never appears in participant list.

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
