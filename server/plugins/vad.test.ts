import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../core/log.ts";
import { Pipeline } from "../core/pipeline.ts";
import type { Logger, MeetingEvent, Plugin } from "../core/types.ts";
import type { SttProvider } from "../providers/stt/types.ts";
import type { TranscriptFinal } from "../testing/l0-bot.ts";
import { transcribe } from "./transcribe.ts";
import { HANGOVER_MS, MAX_MS, vad, type AudioUtterance } from "./vad.ts";

const quiet: Logger = { info() {}, warn() {}, error() {} };
const LOUD = 6000; // ≈ -15 dBFS
const SILENT = 0;

// Feed 20 ms PCM frames for one speaker: script(t) → amplitude (square wave).
async function run(script: (t: number) => number, untilMs: number, extra: Plugin[] = [], after?: (p: Pipeline) => void) {
  const log = new EventLog();
  log.createMeeting({ id: "m", title: "t", startedAt: 0, durationMs: 3_600_000 });
  const pipe = new Pipeline(log, quiet);
  const utterances: MeetingEvent<AudioUtterance>[] = [];
  await pipe.use(vad());
  await pipe.use({ name: "tap", subscribes: ["audio.utterance"], handle: async (ev) => void utterances.push(ev as MeetingEvent<AudioUtterance>) });
  for (const p of extra) await pipe.use(p);
  for (let t = 0; t < untilMs; t += 20) {
    const a = script(t);
    const samples = new Int16Array(320).map((_, i) => (i % 2 ? a : -a));
    pipe.publish({ meetingId: "m", topic: "audio.pcm", t, source: "alice", data: { samples } }, { durable: false });
  }
  after?.(pipe);
  await pipe.drain();
  return { utterances, log };
}

test("two phrases separated by a pause → two utterances with capture-time bounds", async () => {
  const speaking = (t: number) => (t >= 1000 && t < 2000) || (t >= 3500 && t < 4500);
  const { utterances } = await run((t) => (speaking(t) ? LOUD : SILENT), 6000);
  assert.equal(utterances.length, 2);
  const [a, b] = utterances as [MeetingEvent<AudioUtterance>, MeetingEvent<AudioUtterance>];
  assert.equal(a.data.speaker, "alice");
  assert.equal(a.t, 800, "starts one pre-roll before onset");
  assert.ok(Math.abs(a.data.endT - 2200) <= 40, `ends with a short tail, got ${a.data.endT}`);
  assert.equal(a.data.samples.length, ((a.data.endT - a.t) * 16_000) / 1000);
  assert.equal(b.t, 3300);
});

test("after a gap in frames, pre-roll does not reach back across it", async () => {
  // Frames only while speaking (like the L1 bot / a paused sender): 1–2 s and 10–11 s.
  const log = new EventLog();
  log.createMeeting({ id: "m", title: "t", startedAt: 0, durationMs: 60_000 });
  const pipe = new Pipeline(log, quiet);
  const got: MeetingEvent<AudioUtterance>[] = [];
  await pipe.use(vad());
  await pipe.use({ name: "tap", subscribes: ["audio.utterance"], handle: async (ev) => void got.push(ev as MeetingEvent<AudioUtterance>) });
  for (const [from, to] of [[1000, 2800], [10_000, 11_800]] as const) {
    for (let t = from; t < to; t += 20) {
      const a = t < to - 800 ? LOUD : SILENT;
      pipe.publish({ meetingId: "m", topic: "audio.pcm", t, source: "alice", data: { samples: new Int16Array(320).map((_, i) => (i % 2 ? a : -a)) } }, { durable: false });
    }
  }
  await pipe.drain();
  assert.deepEqual(got.map((u) => u.t), [1000, 10_000]);
});

test("a pause shorter than the hangover stays inside one utterance", async () => {
  const gap = HANGOVER_MS - 200;
  const { utterances } = await run((t) => ((t >= 1000 && t < 2000) || (t >= 2000 + gap && t < 3000 + gap) ? LOUD : SILENT), 5000);
  assert.equal(utterances.length, 1);
});

test("clicks shorter than MIN_SPEECH_MS are dropped; silence emits nothing", async () => {
  const { utterances } = await run((t) => (t >= 1000 && t < 1100 ? LOUD : SILENT), 3000);
  assert.equal(utterances.length, 0);
});

test("a monologue is cut at MAX_MS so captions keep flowing", async () => {
  const { utterances } = await run(() => LOUD, MAX_MS * 2 + 1000);
  assert.ok(utterances.length >= 2);
  assert.ok(utterances.every((u) => u.data.endT - u.t <= MAX_MS));
});

test("leaving mid-sentence flushes the open utterance", async () => {
  const { utterances } = await run((t) => (t >= 1000 ? LOUD : SILENT), 2000, [], (p) =>
    p.publish({ meetingId: "m", topic: "presence.leave", t: 2000, source: "alice", data: {} }),
  );
  assert.equal(utterances.length, 1);
});

test("transcribe: utterance → transcript.final at the utterance's t, empty text dropped", async () => {
  const calls: number[] = [];
  const fake: SttProvider = {
    name: "fake",
    async transcribe(samples) {
      calls.push(samples.length);
      return { text: calls.length === 1 ? "hello there" : "" };
    },
  };
  const speaking = (t: number) => (t >= 1000 && t < 2000) || (t >= 3500 && t < 4500);
  const { log } = await run((t) => (speaking(t) ? LOUD : SILENT), 6000, [transcribe(fake)]);
  const finals = log.query("m", { topic: "transcript.final" });
  assert.equal(calls.length, 2);
  assert.equal(finals.length, 1);
  const data = finals[0]!.data as TranscriptFinal;
  assert.equal(finals[0]!.t, 800);
  assert.deepEqual([data.speaker, data.text], ["alice", "hello there"]);
});
