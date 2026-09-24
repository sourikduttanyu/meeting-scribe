// Phase 3.5 verify: what the SFU buys us, measured with real Chrome bots.
// Usage: npm run e2e:sfu            (BOTS=5 npm run e2e:sfu for a bigger room)
//
// 1. Upload once: a client's upload rate must not grow when more people join
//    (in the mesh it grew by one copy per peer).
// 2. Keyframe on subscribe: a late joiner decodes everyone's video quickly,
//    because subscribing to a video track sends a PLI to its publisher.
// 3. Cost: server CPU per forwarded stream.
import assert from "node:assert/strict";
import { startApp } from "../app.ts";
import { launchBot, mediaStats, type L3Bot } from "./l3-bot.ts";

const BOTS = Number(process.env.BOTS ?? 3);
const app = await startApp();
const bots: L3Bot[] = [];
const step = (msg: string) => console.log(`• ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timeout: ${what} (last: ${JSON.stringify(v)})`);
    await sleep(100);
  }
}

// Upload rate (kbps) of one client over a window.
async function uploadKbps(bot: L3Bot, ms = 4_000): Promise<number> {
  const a = (await mediaStats(bot.page)).bytesOut;
  await sleep(ms);
  const b = (await mediaStats(bot.page)).bytesOut;
  return ((b - a) * 8) / ms;
}

// Every remote video tile on this page has decoded at least one frame.
const allVideoDecoding = (bot: L3Bot, peers: number) =>
  bot.page.evaluate((n) => {
    const vids = [...document.querySelectorAll<HTMLVideoElement>(".tile:not(.self) video")].filter((v) => v.srcObject);
    return vids.length >= n && vids.every((v) => v.videoWidth > 0);
  }, peers);

try {
  const res = await fetch(`${app.url}/api/meetings`, { method: "POST", body: JSON.stringify({ title: "e2e sfu", durationMs: 300_000 }) });
  const { id } = (await res.json()) as { id: string };
  step(`meeting ${id}, ${BOTS} bots`);

  bots.push(await launchBot({ baseUrl: app.url, meetingId: id, name: "bot-1" }));
  bots.push(await launchBot({ baseUrl: app.url, meetingId: id, name: "bot-2" }));
  const first = bots[0]!;
  await until("2 bots see each other's video", () => allVideoDecoding(first, 1), Boolean);
  await sleep(4_000); // let the encoder's bandwidth estimate settle
  const up2 = await uploadKbps(first);
  step(`bot-1 upload with 1 peer: ${up2.toFixed(0)} kbps`);

  for (let i = 3; i <= BOTS; i++) {
    const joinedAt = Date.now();
    const bot = await launchBot({ baseUrl: app.url, meetingId: id, name: `bot-${i}` });
    bots.push(bot);
    await until(`bot-${i} decodes all ${i - 1} peers`, () => allVideoDecoding(bot, i - 1), Boolean);
    step(`bot-${i} joined → decoding video from all ${i - 1} peers after ${Date.now() - joinedAt} ms (incl. Chrome launch)`);
  }

  // Late joiner timing without the Chrome launch: from its subscribe connection
  // coming up to every remote video decoding. Needs a PLI to be fast.
  const late = await launchBot({ baseUrl: app.url, meetingId: id, name: "late" });
  bots.push(late);
  await until("late sub connected", () => mediaStats(late.page), (s) => s.sub === "connected", 20_000);
  const subUp = Date.now();
  await until("late joiner decodes everyone", () => allVideoDecoding(late, BOTS), Boolean, 5_000);
  const firstFrames = Date.now() - subUp;
  step(`late joiner: all ${BOTS} remote videos decoding ${firstFrames} ms after its subscribe PC connected`);
  assert.ok(firstFrames < 1_500, "keyframe request on subscribe should make first frames fast");

  await sleep(3_000);
  const upN = await uploadKbps(first);
  const ratio = upN / up2;
  step(`bot-1 upload with ${BOTS} peers: ${upN.toFixed(0)} kbps (×${ratio.toFixed(2)} vs 1 peer; mesh would be ×${BOTS})`);
  // Some growth is the encoder still ramping up; one copy per peer would be ×BOTS.
  assert.ok(ratio < 2, "upload must not scale with the number of peers");

  // Server cost: CPU of this process (signaling + SFU + Scribe) per forwarded stream.
  const n = BOTS + 1;
  const forwarded = n * (n - 1) * 2 + n; // audio+video to every other client, plus each mic to the Scribe
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  await sleep(5_000);
  const cpu = process.cpuUsage(c0);
  const wall = (performance.now() - t0) * 1000;
  const pct = ((cpu.user + cpu.system) / wall) * 100;
  step(`server CPU ${pct.toFixed(1)}% of one core for ${forwarded} forwarded streams (${n} clients) → ${(pct / forwarded).toFixed(2)}% per stream`);

  console.log("\nPASS");
} catch (err) {
  console.error("\nFAIL", err);
  process.exitCode = 1;
} finally {
  await Promise.all(bots.map((b) => b.close()));
  await app.close();
}
