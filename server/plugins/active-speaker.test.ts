import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../core/log.ts";
import { foldNow } from "../core/now.ts";
import { Pipeline } from "../core/pipeline.ts";
import type { Logger } from "../core/types.ts";
import { activeSpeaker, HOLD_MS, SILENCE_MS } from "./active-speaker.ts";

const quiet: Logger = { info() {}, warn() {}, error() {} };

// Synthetic RTP levels: 20 ms packets per participant, loud (-25 dBov) or silent (-127).
async function run(script: (t: number) => { a: number; b: number }, untilMs: number) {
  const log = new EventLog();
  log.createMeeting({ id: "m", title: "t", startedAt: 0, durationMs: 60_000 });
  const pipe = new Pipeline(log, quiet);
  await pipe.use(activeSpeaker());
  for (let t = 0; t < untilMs; t += 20) {
    const lv = script(t);
    for (const [who, dbov] of Object.entries(lv)) {
      pipe.publish({ meetingId: "m", topic: "audio.level", t, source: who, data: { dbov, voice: false } }, { durable: false });
    }
  }
  await pipe.drain();
  return log.query("m", { topic: "speaker.active" }).map((e) => ({ t: e.t, id: (e.data as { id: string | null }).id }));
}

const LOUD = -25;
const QUIET = -127;

test("turns: a, then b, then silence", async () => {
  const ev = await run((t) => ({ a: t < 3000 ? LOUD : QUIET, b: t >= 3000 && t < 6000 ? LOUD : QUIET }), 9000);
  assert.deepEqual(ev.map((e) => e.id), ["a", "b", null]);
  // t is when the change began, not when it was confirmed (within one EMA settle)
  assert.ok(Math.abs(ev[1]!.t - 3000) < 200, `b at ${ev[1]!.t}`);
  assert.ok(Math.abs(ev[2]!.t - 6000) < 400, `silence at ${ev[2]!.t}`);
});

test("short interjection under HOLD_MS does not steal the floor", async () => {
  const ev = await run((t) => ({ a: LOUD, b: t >= 2000 && t < 2000 + HOLD_MS - 200 ? -5 : QUIET }), 5000);
  assert.deepEqual(ev.map((e) => e.id), ["a"]);
});

test("pause shorter than SILENCE_MS keeps the speaker", async () => {
  const ev = await run((t) => ({ a: t >= 2000 && t < 2000 + SILENCE_MS - 500 ? QUIET : LOUD, b: QUIET }), 6000);
  assert.deepEqual(ev.map((e) => e.id), ["a"]);
});

test("overlap: louder one wins", async () => {
  const ev = await run(() => ({ a: -35, b: -20 }), 2000);
  assert.deepEqual(ev.map((e) => e.id), ["b"]);
});

test("foldNow: participants, share stack, speaker, coverage, at any t", () => {
  const e = (t: number, topic: string, source: string, data: unknown) => ({ id: `${t}${topic}`, meetingId: "m", t, topic, source, data, durable: true });
  const log = [
    e(0, "scribe.online", "scribe", {}),
    e(0, "presence.join", "a", { name: "Alice", bot: false }),
    e(1000, "presence.join", "b", { name: "Bob", bot: true }),
    e(2000, "speaker.active", "active-speaker", { id: "a" }),
    e(3000, "screen.share.start", "a", { by: "a" }),
    e(4000, "screen.share.start", "b", { by: "b" }),
    e(5000, "screen.share.stop", "b", { by: "b" }),
    e(6000, "presence.leave", "a", {}),
    e(7000, "scribe.offline", "scribe", {}),
  ];
  assert.deepEqual(foldNow(log, 500), { t: 500, participants: [{ id: "a", name: "Alice", bot: false }], sharing: null, speaking: null, scribeOnline: true });
  assert.equal(foldNow(log, 4500).sharing?.by, "b", "latest sharer shown");
  assert.equal(foldNow(log, 5500).sharing?.by, "a", "a's share resumes when b stops");
  assert.equal(foldNow(log, 5500).speaking, "a");
  const after = foldNow(log, 6500);
  assert.equal(after.speaking, null, "leaving clears speaker");
  assert.deepEqual(after.participants.map((p) => p.name), ["Bob"]);
  assert.equal(foldNow(log, 7500).scribeOnline, false);
});
