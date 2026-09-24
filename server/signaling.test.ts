import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp, type App } from "./app.ts";
import type { Presence } from "./testing/l0-bot.ts";
import type { ServerMsg } from "./signaling.ts";

let app: App;
before(async () => {
  app = await startApp({ scribe: false }); // drives recorders by hand
});
after(() => app.close());

// Minimal WS client: collects messages and lets a test await the next of a type.
async function client() {
  const ws = new WebSocket(app.url.replace("http", "ws") + "/ws");
  const inbox: ServerMsg[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    inbox.push(JSON.parse(String(e.data)));
    waiters.splice(0).forEach((w) => w());
  };
  await new Promise((r) => (ws.onopen = r));
  return {
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    inbox,
    async next<T extends ServerMsg["type"]>(type: T): Promise<Extract<ServerMsg, { type: T }>> {
      for (;;) {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return inbox.splice(i, 1)[0] as Extract<ServerMsg, { type: T }>;
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  };
}

async function createMeeting() {
  const res = await fetch(`${app.url}/api/meetings`, {
    method: "POST",
    body: JSON.stringify({ title: "t", durationMs: 60_000 }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

test("rejects bad meeting duration", async () => {
  const res = await fetch(`${app.url}/api/meetings`, { method: "POST", body: JSON.stringify({ durationMs: 5 }) });
  assert.equal(res.status, 400);
});

test("join, relay, hidden recorder, leave, presence events", async () => {
  const { id } = await createMeeting();
  const meta = async () => (await (await fetch(`${app.url}/api/meetings/${id}`)).json()) as { startedAt: number | null };
  assert.equal((await meta()).startedAt, null, "clock not started at creation");

  // A recorder joining first must not start the clock.
  const early = await client();
  early.send({ type: "join", meetingId: id, name: "EarlyScribe", role: "recorder" });
  await early.next("welcome");
  assert.equal((await meta()).startedAt, null);
  early.close();

  const a = await client();
  a.send({ type: "join", meetingId: id, name: "Alice" });
  const wa = await a.next("welcome");
  assert.ok(wa.meeting.startedAt !== null, "first participant starts the clock");
  assert.equal((await meta()).startedAt, wa.meeting.startedAt);
  assert.deepEqual(wa.peers, []);
  assert.equal(wa.recorder, null);

  const b = await client();
  b.send({ type: "join", meetingId: id, name: "Bob" });
  const wb = await b.next("welcome");
  assert.deepEqual(wb.peers.map((p) => p.name), ["Alice"]);
  assert.equal((await a.next("peer-joined")).peer.name, "Bob");

  // Relay stays inside the room and carries the sender id.
  a.send({ type: "signal", to: wb.selfId, data: { hello: 1 } });
  const sig = await b.next("signal");
  assert.equal(sig.from, wa.selfId);
  assert.deepEqual(sig.data, { hello: 1 });

  // Recorder: announced as recorder, never as a peer.
  const rec = await client();
  rec.send({ type: "join", meetingId: id, name: "Scribe", role: "recorder" });
  const wr = await rec.next("welcome");
  assert.deepEqual(wr.peers.map((p) => p.name).sort(), ["Alice", "Bob"]);
  assert.equal((await a.next("recorder-joined")).peer.id, wr.selfId);
  await b.next("recorder-joined");

  const c = await client();
  c.send({ type: "join", meetingId: id, name: "Carol" });
  const wc = await c.next("welcome");
  assert.deepEqual(wc.peers.map((p) => p.name).sort(), ["Alice", "Bob"]);
  assert.equal(wc.recorder?.id, wr.selfId);
  assert.ok(![...a.inbox].some((m) => m.type === "peer-joined" && m.peer.id === wr.selfId));

  b.close();
  assert.equal((await a.next("peer-left")).id, wb.selfId);

  // Presence reaches the pipeline, recorder excluded.
  await app.pipeline.drain();
  const presence = app.log.query(id, { topic: "presence.*" });
  assert.deepEqual(
    presence.map((e) => `${e.topic}:${(e.data as Presence).name}`),
    ["presence.join:Alice", "presence.join:Bob", "presence.join:Carol", "presence.leave:Bob"],
  );
  assert.ok(presence.every((e) => e.t >= 0 && e.t < 60_000));
  assert.ok(presence[0]!.t < 100, `first join is ~t=0, got ${presence[0]!.t}`);
  for (const x of [a, c, rec]) x.close();
});

test("unknown meeting and signal before join are errors", async () => {
  const x = await client();
  x.send({ type: "signal", to: "nobody", data: {} });
  assert.match((await x.next("error")).message, /join first/);
  x.send({ type: "join", meetingId: "nope", name: "X" });
  assert.match((await x.next("error")).message, /unknown meeting/);
  x.close();
});

test("static server blocks path traversal", async () => {
  const res = await fetch(`${app.url}/..%2f..%2fpackage.json`);
  assert.notEqual(res.status, 200);
  assert.equal((await fetch(`${app.url}/room.html`)).status, 200);
});
