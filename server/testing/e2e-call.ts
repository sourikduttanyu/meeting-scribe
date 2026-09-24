// End-to-end call check with two L3 (real Chrome) bots.
// Usage: npm run e2e:call
import assert from "node:assert/strict";
import { startApp } from "../app.ts";
import { launchBot, mediaStats, type L3Bot } from "./l3-bot.ts";

const app = await startApp({ scribe: false }); // this test drives a fake recorder itself; e2e:scribe covers the real one
const bots: L3Bot[] = [];
const step = (msg: string) => console.log(`• ${msg}`);

async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timeout: ${what} (last: ${JSON.stringify(v)})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

try {
  const res = await fetch(`${app.url}/api/meetings`, {
    method: "POST",
    body: JSON.stringify({ title: "e2e call", durationMs: 120_000 }),
  });
  const { id } = (await res.json()) as { id: string };
  step(`meeting ${id} at ${app.url}/room.html?m=${id}`);

  bots.push(await launchBot({ baseUrl: app.url, meetingId: id, name: "alice", voice: "Samantha" }));
  bots.push(await launchBot({ baseUrl: app.url, meetingId: id, name: "bob", voice: "Daniel" }));
  const [alice, bob] = bots as [L3Bot, L3Bot];

  const t0 = Date.now();
  for (const b of bots) {
    await until(`${b.name} connected with audio+video`, () => mediaStats(b.page),
      (s) => s.connected === 1 && s.audioBytesIn > 2000 && s.videoBytesIn > 2000);
  }
  step(`both connected, audio+video flowing (${Date.now() - t0} ms)`);

  // Hidden recorder: banner turns on, no new peer/tile appears.
  const rec = new WebSocket(app.url.replace("http", "ws") + "/ws");
  await new Promise((r) => (rec.onopen = r));
  rec.send(JSON.stringify({ type: "join", meetingId: id, name: "Scribe", role: "recorder" }));
  for (const b of bots) {
    await until(`${b.name} sees AI banner`, () => b.page.evaluate(() => (window as any).__room.recorderPresent), (v) => v === true);
    assert.equal((await mediaStats(b.page)).peers, 1, "recorder must not become a peer");
  }
  step("recorder joined: banner on for both, still 1 peer each");

  // Mid-call screen share from alice → renegotiation (perfect negotiation path).
  const tilesBefore = await bob.page.locator(".tile").count();
  await alice.page.click("#share");
  await until("bob gets a screen tile", () => bob.page.locator(".tile.screen").count(), (n) => n === 1);
  step(`screen share renegotiated: bob tiles ${tilesBefore} → ${await bob.page.locator(".tile").count()}`);
  await alice.page.click("#share");
  await until("screen tile removed", () => bob.page.locator(".tile.screen").count(), (n) => n === 0);
  step("screen share stopped: tile removed");

  rec.close();
  await alice.page.click("#leave");
  await until("bob sees alice leave", () => mediaStats(bob.page), (s) => s.peers === 0);
  await app.pipeline.drain();
  const presence = app.log.query(id, { topic: "presence.*" }).map((e) => `${e.topic}:${(e.data as { name: string }).name}@${e.t}ms`);
  step(`presence log: ${presence.join(", ")}`);
  console.log("\nPASS");
} catch (err) {
  console.error("\nFAIL", err);
  process.exitCode = 1;
} finally {
  await Promise.all(bots.map((b) => b.close()));
  await app.close();
}
