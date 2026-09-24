// Phase 4 verify: live captions end to end with real Chrome bots and real
// Whisper. Needs whisper-server on :8178.
// Usage: npm run e2e:captions
//
// alice talks (a known sentence, looped with pauses); bob listens muted.
// Checks what bob's Live tab shows: right words, right speaker, and how long
// after the end of each utterance the caption appeared. Then a late joiner
// must see the captions from before it joined.
import assert from "node:assert/strict";
import { startApp } from "../app.ts";
import { whisperCpp } from "../providers/stt/whisper-cpp.ts";
import { launchBot, type L3Bot } from "./l3-bot.ts";
import { wer } from "./wer.ts";

const SENTENCE = "The quarterly budget review moves to Thursday afternoon at three.";
const app = await startApp({ stt: whisperCpp() });
const bots: L3Bot[] = [];
const step = (msg: string) => console.log(`• ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seen = { t: number; end: number; who: string; text: string; at: number };
const captions = (bot: L3Bot) => bot.page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen ?? []);

try {
  const res = await fetch(`${app.url}/api/meetings`, { method: "POST", body: JSON.stringify({ title: "e2e captions", durationMs: 300_000 }) });
  const { id } = (await res.json()) as { id: string };
  step(`meeting ${id}`);

  const bob = await launchBot({ baseUrl: app.url, meetingId: id, name: "bob", voice: "Daniel" });
  bots.push(bob);
  await bob.page.waitForFunction(() => (window as any).__room?.selfId);
  await bob.page.keyboard.press("m"); // listener only
  // Record when each caption shows up in bob's DOM (wall clock, in the page).
  await bob.page.evaluate(() => {
    const w = window as unknown as { __seen: Seen[] };
    w.__seen = [];
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        const li = n as HTMLElement;
        w.__seen.push({ t: Number(li.dataset.t), end: Number(li.dataset.end), who: li.querySelector(".who")!.textContent!, text: li.querySelector(".text")!.textContent!, at: Date.now() });
      }
    }).observe(document.querySelector("#captions")!, { childList: true });
  });

  const alice = await launchBot({ baseUrl: app.url, meetingId: id, name: "alice", voice: "Samantha", say: `${SENTENCE} [[slnc 2500]]` });
  bots.push(alice);
  const startedAt = app.log.getMeeting(id)!.startedAt!;

  const deadline = Date.now() + 40_000;
  while ((await captions(bob)).length < 3 && Date.now() < deadline) await sleep(500);
  const seen = await captions(bob);
  assert.ok(seen.length >= 3, `expected ≥3 captions, got ${seen.length}`);

  for (const c of seen) step(`${(c.t / 1000).toFixed(1)}s ${c.who}: "${c.text}" — shown ${c.at - (startedAt + c.end)} ms after speech ended`);
  // The first loop iteration can start mid-sentence (the fake mic starts before we join), so score the rest.
  const full = seen.slice(1);
  const w = full.map((c) => wer(SENTENCE, c.text).wer);
  const lat = full.map((c) => c.at - (startedAt + c.end)).sort((a, b) => a - b);
  step(`WER per caption: ${w.map((x) => (x * 100).toFixed(0) + "%").join(", ")}`);
  step(`caption latency after end of speech: p50 ${lat[Math.floor(lat.length / 2)]} ms, max ${lat.at(-1)} ms (VAD hangover alone is 600 ms)`);
  assert.ok(full.every((c) => c.who === "alice"), "attributed to alice");
  assert.ok(w.every((x) => x <= 0.2), "captions match what was said");
  assert.ok(lat[Math.floor(lat.length / 2)]! < 2_000, "p50 caption latency under 2 s");

  const carol = await launchBot({ baseUrl: app.url, meetingId: id, name: "carol" });
  bots.push(carol);
  await carol.page.waitForFunction(() => document.querySelectorAll("#captions li").length > 0, null, { timeout: 10_000 });
  const history = await carol.page.locator("#captions li").count();
  step(`late joiner carol sees ${history} earlier captions on arrival`);
  assert.ok(history >= seen.length);

  console.log("\nPASS");
} catch (err) {
  console.error("\nFAIL", err);
  process.exitCode = 1;
} finally {
  await Promise.all(bots.map((b) => b.close()));
  await app.close();
}
