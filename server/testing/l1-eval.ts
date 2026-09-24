// L1 eval: scenario voices → audio.pcm → VAD → Whisper → transcript.final,
// scored against the script (ground truth). Needs whisper-server on :8178.
// Usage: npm run eval:l1 -- scenarios/budget-review.json
//
// The L1 bot enters where the Scribe would: per-speaker 16 kHz PCM at
// scenario time, in 20 ms frames, with a second of silence after each line.
// Event time only, so a 4-minute meeting replays as fast as Whisper runs.
import { readFileSync } from "node:fs";
import { EventLog } from "../core/log.ts";
import { Pipeline } from "../core/pipeline.ts";
import { PCM_RATE } from "../ingest/scribe.ts";
import { transcribe, type TranscriptMeta } from "../plugins/transcribe.ts";
import { vad } from "../plugins/vad.ts";
import { whisperCpp } from "../providers/stt/whisper-cpp.ts";
import type { TranscriptFinal } from "./l0-bot.ts";
import { loadScenario } from "./scenario.ts";
import { renderSpeech } from "./tts.ts";
import { wer } from "./wer.ts";

const file = process.argv[2] ?? "scenarios/budget-review.json";
const scenario = loadScenario(file);
const voices = new Map(scenario.participants.map((p) => [p.id, p.voice]));
const lines = scenario.script.flatMap((l) => ("say" in l ? [l] : []));

// 1. Frames for every line, then interleave all speakers by t.
const FRAME = 320;
const frames: { t: number; who: string; samples: Int16Array }[] = [];
const truth = lines.map((l) => {
  const r = renderSpeech(voices.get(l.who)!, l.say);
  const pcm = new Int16Array(readFileSync(r.path).buffer.slice(44));
  const total = pcm.length + PCM_RATE; // + 1 s silence
  for (let i = 0; i < total; i += FRAME) {
    const samples = i < pcm.length ? pcm.slice(i, i + FRAME) : new Int16Array(FRAME);
    frames.push({ t: l.at + (i / PCM_RATE) * 1000, who: l.who, samples });
  }
  return { ...l, endT: l.at + r.durationMs };
});
frames.sort((a, b) => a.t - b.t);

// 2. Replay through the real VAD + Whisper.
const log = new EventLog();
log.createMeeting({ id: "l1", title: scenario.title, startedAt: 0, durationMs: scenario.durationMs });
const pipe = new Pipeline(log);
await pipe.use(vad());
await pipe.use(transcribe(whisperCpp()));
const wall = performance.now();
for (const f of frames) pipe.publish({ meetingId: "l1", topic: "audio.pcm", t: f.t, source: f.who, data: { samples: f.samples } }, { durable: false });
pipe.publish({ meetingId: "l1", topic: "scribe.offline", t: scenario.durationMs, source: "scribe", data: {} });
await pipe.drain();
const wallMs = performance.now() - wall;

// 3. Score: each transcript is matched to the script line it overlaps most.
const finals = log.query("l1", { topic: "transcript.final" }).map((e) => ({ t: e.t, ...(e.data as TranscriptFinal & TranscriptMeta) }));
const hyp = new Map<number, typeof finals>(truth.map((_, i) => [i, []]));
let misattributed = 0;
let unmatched = 0;
for (const f of finals) {
  let best = -1;
  let bestOverlap = 0;
  truth.forEach((l, i) => {
    const overlap = Math.min(f.endT, l.endT) - Math.max(f.t, l.at);
    if (overlap > bestOverlap) [best, bestOverlap] = [i, overlap];
  });
  if (best < 0) unmatched++;
  else {
    hyp.get(best)!.push(f);
    if (truth[best]!.who !== f.speaker) misattributed++;
  }
}

let errors = 0;
let words = 0;
let maxStartSkew = 0;
const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
truth.forEach((l, i) => {
  const hs = hyp.get(i)!;
  const said = hs.map((h) => h.text).join(" ");
  const w = wer(l.say, said);
  errors += w.errors;
  words += w.words;
  if (hs[0]) maxStartSkew = Math.max(maxStartSkew, Math.abs(hs[0].t - l.at));
  const mark = w.errors === 0 ? "✓" : `${w.errors} err`;
  console.log(`${mmss(l.at)} ${l.who.padEnd(6)} ${mark.padEnd(6)} ${said || "(nothing)"}`);
});

const stt = finals.map((f) => f.sttMs).sort((a, b) => a - b);
const audioMs = truth.reduce((n, l) => n + (l.endT - l.at), 0);
console.log(`
utterances   ${finals.length} transcripts for ${truth.length} script lines (${unmatched} unmatched)
WER          ${((errors / words) * 100).toFixed(1)}% (${errors}/${words} words, after number/punctuation normalization)
speakers     ${misattributed} misattributed
timing       max |transcript start − script start| = ${maxStartSkew} ms (VAD pre-roll is 200 ms)
whisper      p50 ${stt[Math.floor(stt.length / 2)]} ms, max ${stt.at(-1)} ms per utterance
throughput   ${(audioMs / 1000).toFixed(0)} s of speech in ${(wallMs / 1000).toFixed(1)} s wall (${(audioMs / wallMs).toFixed(1)}× realtime)`);
