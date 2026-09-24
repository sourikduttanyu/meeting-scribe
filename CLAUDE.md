# Meeting Live Transcode AI Helper

Video meeting platform with a pseudo-realtime AI timeline. A hidden server-side "Scribe" peer captures every participant's media, a plugin pipeline turns it into timestamped events (transcripts, screen text, summaries), and anyone — including late joiners — can ask "what happened in the first 5 min / first half?".

See `PLAN.md` for phases, status, and the scale path.

## Goals & constraints

- **$0 POC** on one Apple M4 / 16GB Mac. Local models only by default (whisper.cpp + Ollama). Paid APIs only as optional providers behind config.
- **Designed for scale.** Keep the POC minimal, but put swap points at seams (interfaces, config). Every non-trivial design decision gets a one-line "at scale → X because Y" note in `PLAN.md` → Decisions. This project doubles as interview material.
- Start at 2 participants (P2P). Growth path is SFU (LiveKit / mediasoup).

## Architecture

```
Browser A ◄── WebRTC P2P call ──► Browser B
   │ sendonly PC (mic, screen)       │ sendonly PC (mic)
   ▼                                 ▼
Node server
  signaling    rooms, roles (participant | recorder); recorder never listed to clients
  ingest/      Scribe peer (werift): RTP → Opus decode → PCM16 16k per speaker
               VP8 → ffmpeg → 1fps JPEG (PLI for keyframes)
  core/        types, topics (NATS-style match), log (SQLite, append-only), pipeline (bus + plugin host)
  plugins/     vad → whisper → transcript; screen → ocr/vision; summarizer; qa
  providers/   STT / LLM / Vision adapters (whisper.cpp, ollama, deepgram, gemini, ...)
```

- **Per-speaker tracks, recorded before mixing** → speaker attribution without diarization.
- **Timestamps = capture time**, ms offset from meeting start. Never use processing time.
- **Event log is source of truth** (event sourcing). Plugins must be replayable over a stored meeting.
- Meetings have a fixed `durationMs`; time-range questions ("first half") resolve against it.
- **Event time, not wall clock.** Plugins schedule on event `t` (e.g. "summarize every 60s" = when `t` crosses the next minute), never `setInterval`/`Date.now()`. Wall clock is only read at the ingest edge. This is what lets bots replay a 2h meeting in seconds.

## Plugin contract

```ts
interface Plugin {
  name: string;
  subscribes: string[];                       // NATS-style: "screen.*" = one segment, "audio.>" = rest
  queue?: { max: number; drop: "oldest" | "newest" | "never" };
  init?(): Promise<void>;
  handle(ev: MeetingEvent, ctx: PluginContext): Promise<void>;
  close?(): Promise<void>;
}
```

Rules:
- Plugins talk **only** through topics (`ctx.emit` / `ctx.query`). No plugin imports another plugin.
- Plugins are stateless across meetings; per-meeting state keyed by `meetingId` (enables partitioning by meetingId at scale).
- Heavy compute goes through a `providers/` adapter (out-of-process model server), never inline.
- Speech queues use `drop: "never"`; screen frames use `drop: "oldest"`. High-volume raw topics (`audio.pcm`) are emitted with `{ durable: false }`.
- Plugins must not rely on receiving their own events (the pipeline skips self-delivery).
- Topic names: `<domain>.<kind>` — `audio.pcm`, `audio.utterance`, `transcript.final`, `screen.frame`, `screen.text`, `summary.chunk`, `qa.answer`.

## Test bots

Scenarios (`scenarios/*.json`) are scripted meetings = ground truth for every level:

| Level | Bot | Enters at | Status |
|---|---|---|---|
| L0 | `server/testing/l0-bot.ts` | publishes `transcript.final` / `screen.text` / `presence.*` | ✅ |
| L1 | audio bot | `audio.pcm` from rendered WAVs | phase 4 |
| L2 | werift WebRTC client | signaling + Scribe, like a real user | later (CI / load tests); L3 covers the real path |
| L3 | `server/testing/l3-bot.ts` (installed Chrome, fake media) | the real web UI | ✅ |

- Event shapes the bots emit are **contracts** real stages must match (`TranscriptFinal`, `ScreenText` in `l0-bot.ts`).
- Voices: macOS `say` → 16 kHz mono WAV, cached in `data/tts/` by hash(voice, text).
- Bots join as normal participants with `bot: true`; any `/dev/*` routes exist only when `NODE_ENV=development`.

## Stack

- Node 25 + TypeScript (ESM), run directly via type stripping — erasable syntax only (no `enum`, no parameter properties). `tsc` (TS 7) typechecks only.
- Built-ins over deps: `node:test`, `node:sqlite`. werift for server-side WebRTC, opusscript (WASM libopus) for decode.
- whisper.cpp via `whisper-server` (Homebrew), model `models/ggml-small.en.bin`.
- Ollama at `localhost:11434`, default model `qwen2.5:7b` (`llama3.2:1b` for fast/cheap calls).
- ffmpeg (Homebrew) for VP8 decode.

## Local services

```sh
brew services start ollama
whisper-server -m models/ggml-small.en.bin --port 8178     # keep warm; cold start ~15s
```

Memory budget (16GB): whisper small.en ~1GB + qwen2.5:7b ~5GB + Chrome tabs. Don't load bigger models without checking.

## Conventions

- Surgical changes; match existing style; no speculative abstractions beyond the seams listed above.
- Each phase in `PLAN.md` has a verify step — run it before marking done, and update the status there.
- **Think → build → verify → critique.** Before a phase: state the approach and alternatives. After it: add a `Critique` block under that phase in `PLAN.md` — what's weak, what breaks at scale, what we'd do differently, and a likely interview question with a short answer.
- Commits: one per logical step, message explains *why*.
- `models/` and `data/` (SQLite, WAV/JPEG dumps) are gitignored.

## Consent

The recorder is hidden from the video grid, **not** from users: the room UI always shows an "AI notes / recording on" indicator and a join notice. Don't remove it.

## Commands

```sh
npm run check      # typecheck + tests
npm test           # tests only (node:test)
npm run scenario -- scenarios/budget-review.json   # render voices, replay via L0, print timeline
npm start          # server on :3000
npm run dev        # + watch mode + /dev routes ("+ Add test bot" button)
npm run e2e:call   # two headless Chrome bots: connect, recorder banner, screen share
npm run e2e:scribe # real Scribe: speaker turns, share start/stop, /now replay, per-speaker WAVs
```
