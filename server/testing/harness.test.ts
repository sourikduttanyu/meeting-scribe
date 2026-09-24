import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventLog } from "../core/log.ts";
import { Pipeline } from "../core/pipeline.ts";
import { runL0, type TranscriptFinal } from "./l0-bot.ts";
import { loadScenario, parseScenario } from "./scenario.ts";
import { renderSpeech, SAMPLE_RATE } from "./tts.ts";

const valid = {
  title: "t",
  durationMs: 10_000,
  participants: [{ id: "a", voice: "Samantha" }],
  script: [{ at: 0, who: "a", say: "hi" }],
};

test("scenario: accepts the sample scenario", () => {
  const s = loadScenario("scenarios/budget-review.json");
  assert.equal(s.participants.length, 3);
});

test("scenario: rejects unknown speaker, out-of-range, unsorted, and ambiguous lines", () => {
  const bad = (script: unknown[]) => () => parseScenario({ ...valid, script });
  assert.throws(bad([{ at: 0, who: "zed", say: "x" }]), /unknown participant/);
  assert.throws(bad([{ at: 99_999, who: "a", say: "x" }]), /outside/);
  assert.throws(bad([{ at: 5, who: "a", say: "x" }, { at: 1, who: "a", say: "y" }]), /sorted/);
  assert.throws(bad([{ at: 0, who: "a", say: "x", join: true }]), /exactly one/);
});

test("L0 bot: replays a 4-minute meeting instantly with scenario timestamps", async () => {
  const s = loadScenario("scenarios/budget-review.json");
  const log = new EventLog();
  log.createMeeting({ id: "m", title: s.title, startedAt: 0, durationMs: s.durationMs });
  const pipe = new Pipeline(log);

  const started = performance.now();
  runL0(s, pipe, "m");
  await pipe.drain();
  assert.ok(performance.now() - started < 1000, "must not depend on wall clock");

  const firstMinute = log.query("m", { topic: "transcript.final", from: 0, to: 60_000 });
  assert.deepEqual(firstMinute.map((e) => e.source), ["alice", "bob", "alice", "bob", "alice", "bob"]);
  assert.ok(firstMinute.every((e) => (e.data as TranscriptFinal).endT > e.t));
  assert.equal(log.query("m", { topic: "screen.text" }).length, 1);
  const joins = log.query("m", { topic: "presence.join" });
  assert.deepEqual(joins.map((e) => [e.source, e.t]), [["alice", 0], ["bob", 0], ["rishi", 90_000]]);
});

test("tts: renders 16 kHz mono PCM16 WAV and caches it", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-"));
  const first = renderSpeech("Samantha", "Testing one two three.", dir);
  assert.equal(first.cached, false);
  assert.ok(first.durationMs > 500 && first.durationMs < 4000, `duration ${first.durationMs}`);

  const header = readFileSync(first.path).subarray(0, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 36, 40), "data"); // no extra chunks → 44-byte header
  assert.equal(header.readUInt16LE(22), 1); // mono
  assert.equal(header.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(header.readUInt16LE(34), 16); // bits per sample

  assert.equal(renderSpeech("Samantha", "Testing one two three.", dir).cached, true);
});
