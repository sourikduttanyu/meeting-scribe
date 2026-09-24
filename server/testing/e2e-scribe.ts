// Phase 3 verify: the real Scribe records two real Chrome participants.
// Usage: npm run e2e:scribe
//
// Script (meeting time): alice talks alone → bob talks alone → both muted.
// alice shares her screen in the middle. Then we check the event log, the
// /now projection, and the per-speaker WAV files against that script.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../app.ts";
import type { NowSnapshot } from "../core/now.ts";
import { PCM_RATE } from "../ingest/scribe.ts";
import { launchBot, type L3Bot } from "./l3-bot.ts";

const TURN_MS = 6_000;
const TOLERANCE_MS = 1_000;
const wavDir = mkdtempSync(join(tmpdir(), "scribe-"));
const app = await startApp({ recordWav: wavDir });
const bots: L3Bot[] = [];
const step = (msg: string) => console.log(`• ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Continuous speech, no pauses: turn boundaries come only from muting.
const SPEECH = "The quick brown fox jumps over the lazy dog, and then it keeps running along the river bank without stopping.";

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timeout: ${what} (last: ${JSON.stringify(v)})`);
    await sleep(250);
  }
}

try {
  const res = await fetch(`${app.url}/api/meetings`, { method: "POST", body: JSON.stringify({ title: "e2e scribe", durationMs: 300_000 }) });
  const { id } = (await res.json()) as { id: string };
  const now = async (t?: number) => (await (await fetch(`${app.url}/api/meetings/${id}/now${t === undefined ? "" : `?t=${t}`}`)).json()) as NowSnapshot;
  step(`meeting ${id}`);

  bots.push(await launchBot({ baseUrl: app.url, meetingId: id, name: "alice", voice: "Samantha", say: SPEECH }));
  bots.push(await launchBot({ baseUrl: app.url, meetingId: id, name: "bob", voice: "Daniel", say: SPEECH }));
  const [alice, bob] = bots as [L3Bot, L3Bot];
  await until("Scribe online + both uplinks connected", () => Promise.all(bots.map((b) => b.page.evaluate(() => {
    const r = (window as any).__room;
    return r.recorderPresent && r.pub?.connectionState === "connected";
  }))), (v) => v.every(Boolean));
  const ids = { alice: await alice.page.evaluate(() => (window as any).__room.selfId), bob: await bob.page.evaluate(() => (window as any).__room.selfId) };
  const name = (pid: string | null) => (pid === ids.alice ? "alice" : pid === ids.bob ? "bob" : String(pid));
  const started = app.log.getMeeting(id)!.startedAt!;
  const mt = () => Date.now() - started; // meeting time
  step("Scribe online, both participants publishing to the SFU");

  // Turn script, driven by the real mute button (M).
  await bob.page.keyboard.press("m");
  const aliceFrom = mt();
  await sleep(TURN_MS);

  await alice.page.click("#share");
  const shareAt = mt();
  const sharing = await until("/now shows alice sharing", () => now(), (n) => n.sharing?.by === ids.alice, 5_000);
  step(`share start visible in /now after ${mt() - shareAt} ms`);

  await alice.page.keyboard.press("m");
  await bob.page.keyboard.press("m");
  const bobFrom = mt();
  await sleep(TURN_MS);

  await alice.page.click("#share");
  const unshareAt = mt();
  await until("/now shows nobody sharing", () => now(), (n) => n.sharing === null, 5_000);
  await bob.page.keyboard.press("m");
  const silentFrom = mt();
  await sleep(3_000);
  const endT = mt();

  const nowSnap = await now();
  assert.equal(nowSnap.scribeOnline, true);
  assert.deepEqual(nowSnap.participants.map((p) => p.name).sort(), ["alice", "bob"]);
  step(`/now: ${JSON.stringify({ ...nowSnap, participants: nowSnap.participants.map((p) => p.name) })}`);

  // speaker.active must follow the script.
  const speakers = app.log.query(id, { topic: "speaker.active" }).map((e) => ({ t: e.t, who: name((e.data as { id: string | null }).id) }));
  step(`speaker.active: ${speakers.map((s) => `${(s.t / 1000).toFixed(1)}s ${s.who}`).join(" → ")}`);
  // Judge by state, via replay: who does /now?t= say was speaking inside each turn?
  const turns = [
    { who: "alice", from: aliceFrom, to: bobFrom },
    { who: "bob", from: bobFrom, to: silentFrom },
    { who: "null", from: silentFrom, to: endT },
  ];
  const lags: string[] = [];
  for (const turn of turns) {
    for (let t = turn.from + TOLERANCE_MS; t < turn.to; t += 500) {
      assert.equal(name((await now(t)).speaking), turn.who, `speaking at ${t} ms`);
    }
    const sw = speakers.find((s) => s.who === turn.who && s.t >= turn.from - TOLERANCE_MS);
    if (sw && turn.from !== aliceFrom) lags.push(`${turn.who} ${sw.t - turn.from} ms`);
  }
  step(`speaker state matches script in every turn (checked every 500 ms after ${TOLERANCE_MS} ms); switch lag: ${lags.join(", ")}`);

  // Exactly one share pair, close to the clicks. Replay answers the past too.
  const shares = app.log.query(id, { topic: "screen.share.>" });
  assert.deepEqual(shares.map((e) => e.topic), ["screen.share.start", "screen.share.stop"]);
  assert.ok(Math.abs(shares[0]!.t - shareAt) <= TOLERANCE_MS, "share start t");
  assert.ok(Math.abs(shares[1]!.t - unshareAt) <= TOLERANCE_MS, "share stop t");
  assert.equal((await now(shareAt + 2_000)).sharing?.by, ids.alice, "replay: sharing mid-share");
  assert.equal((await now(aliceFrom + 1_000)).sharing, null, "replay: nothing shared before");
  step(`one share start/stop pair (${shares.map((e) => (e.t / 1000).toFixed(1) + "s").join(", ")}); replayed /now?t= agrees`);
  void sharing;

  // Per-speaker WAVs: aligned to meeting t=0, loud only in their own turn.
  for (const [who, pid] of Object.entries(ids)) {
    const file = join(wavDir, id, `${pid}.wav`);
    const pcm = new Int16Array(readFileSync(file).buffer.slice(44));
    const rms = (from: number, to: number) => {
      let sum = 0;
      const a = Math.round((from * PCM_RATE) / 1000);
      const b = Math.min(pcm.length, Math.round((to * PCM_RATE) / 1000));
      for (let i = a; i < b; i++) sum += pcm[i]! ** 2;
      return Math.sqrt(sum / Math.max(1, b - a));
    };
    const inAlice = rms(aliceFrom + 1_000, bobFrom - 500);
    const inBob = rms(bobFrom + 1_000, silentFrom - 500);
    const durS = (statSync(file).size - 44) / 2 / PCM_RATE;
    step(`${who}.wav ${durS.toFixed(1)}s, rms alice-turn ${inAlice.toFixed(0)} bob-turn ${inBob.toFixed(0)}`);
    assert.ok(Math.abs(durS * 1000 - endT) < 2_000, `${who} wav spans the meeting`);
    const [mine, theirs] = who === "alice" ? [inAlice, inBob] : [inBob, inAlice];
    assert.ok(mine > 300 && theirs < 50, `${who}: own turn loud, other turn silent`);
  }
  step(`wav files in ${join(wavDir, id)}`);

  await app.close(); // Scribe leaves → scribe.offline
  step("PASS");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await Promise.all(bots.map((b) => b.close()));
  await app.close().catch(() => {});
}
