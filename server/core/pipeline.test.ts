import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { EventLog } from "./log.ts";
import { Pipeline } from "./pipeline.ts";
import type { Logger, MeetingEvent, Plugin } from "./types.ts";

const quiet: Logger = { info() {}, warn() {}, error() {} };
let log: EventLog;
let pipe: Pipeline;

beforeEach(() => {
  log = new EventLog();
  log.createMeeting({ id: "m1", title: "Standup", startedAt: 0, durationMs: 60_000 });
  log.createMeeting({ id: "m2", title: "Other", startedAt: 0, durationMs: 60_000 });
  pipe = new Pipeline(log, quiet);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recorder(name: string, subscribes: string[], extra: Partial<Plugin> = {}) {
  const seen: MeetingEvent[] = [];
  const plugin: Plugin = { name, subscribes, handle: async (ev) => void seen.push(ev), ...extra };
  return { plugin, seen };
}

test("delivers in order, derived events land in the log, time-range query slices", async () => {
  const upper: Plugin = {
    name: "upper",
    subscribes: ["test.*"],
    async handle(ev, ctx) {
      ctx.emit("derived.upper", ev.t, String(ev.data).toUpperCase());
    },
  };
  const { plugin, seen } = recorder("rec", ["test.*"]);
  await pipe.use(upper);
  await pipe.use(plugin);

  for (const [t, word] of [[1000, "a"], [2000, "b"], [3000, "c"]] as const) {
    pipe.publish({ meetingId: "m1", topic: "test.word", t, source: "alice", data: word });
  }
  await pipe.drain();

  assert.deepEqual(seen.map((e) => e.data), ["a", "b", "c"]);
  const derived = log.query("m1", { topic: "derived.*" });
  assert.deepEqual(derived.map((e) => [e.t, e.data, e.source]), [
    [1000, "A", "upper"],
    [2000, "B", "upper"],
    [3000, "C", "upper"],
  ]);
  assert.deepEqual(log.query("m1", { from: 1500, to: 2500 }).map((e) => e.data), ["b", "B"]);
});

test("a plugin never receives its own events (no feedback loop)", async () => {
  let calls = 0;
  await pipe.use({
    name: "echo",
    subscribes: [">"],
    async handle(ev, ctx) {
      calls++;
      ctx.emit("echo.again", ev.t, null);
    },
  });
  pipe.publish({ meetingId: "m1", topic: "x.y", t: 0, source: "alice", data: null });
  await pipe.drain();
  assert.equal(calls, 1);
});

test("ctx is scoped to the event's meeting", async () => {
  let visible: MeetingEvent[] = [];
  await pipe.use({
    name: "peek",
    subscribes: ["ask.now"],
    async handle(_ev, ctx) {
      visible = ctx.query();
    },
  });
  pipe.publish({ meetingId: "m2", topic: "secret.note", t: 0, source: "bob", data: "m2 only" });
  pipe.publish({ meetingId: "m1", topic: "ask.now", t: 0, source: "alice", data: null });
  await pipe.drain();
  assert.deepEqual(visible.map((e) => e.meetingId), ["m1"]);
});

test("non-durable events are delivered but not logged", async () => {
  const { plugin, seen } = recorder("rec", ["audio.pcm"]);
  await pipe.use(plugin);
  pipe.publish({ meetingId: "m1", topic: "audio.pcm", t: 0, source: "alice", data: [1, 2] }, { durable: false });
  await pipe.drain();
  assert.equal(seen.length, 1);
  assert.equal(log.query("m1").length, 0);
});

test("drop: oldest keeps the freshest events under load", async () => {
  const { plugin, seen } = recorder("slow", ["screen.frame"], {
    queue: { max: 2, drop: "oldest" },
  });
  const inner = plugin.handle;
  plugin.handle = async (ev, ctx) => {
    await sleep(5);
    await inner(ev, ctx);
  };
  await pipe.use(plugin);
  for (let i = 0; i < 5; i++) {
    pipe.publish({ meetingId: "m1", topic: "screen.frame", t: i, source: "alice", data: i }, { durable: false });
  }
  await pipe.drain();
  assert.deepEqual(seen.map((e) => e.data), [3, 4]);
  assert.equal(pipe.stats()[0]?.dropped, 3);
});

test("drop: never keeps everything and warns", async () => {
  const warnings: unknown[] = [];
  pipe = new Pipeline(log, { ...quiet, warn: (m: unknown) => void warnings.push(m) });
  const { plugin, seen } = recorder("stt", ["audio.utterance"], { queue: { max: 1, drop: "never" } });
  await pipe.use(plugin);
  for (let i = 0; i < 4; i++) {
    pipe.publish({ meetingId: "m1", topic: "audio.utterance", t: i, source: "alice", data: i });
  }
  await pipe.drain();
  assert.equal(seen.length, 4);
  assert.equal(warnings.length, 1);
});

test("a throwing plugin does not stop others", async () => {
  await pipe.use({ name: "bad", subscribes: ["x.y"], handle: async () => { throw new Error("boom"); } });
  const { plugin, seen } = recorder("good", ["x.y"]);
  await pipe.use(plugin);
  pipe.publish({ meetingId: "m1", topic: "x.y", t: 0, source: "alice", data: 1 });
  pipe.publish({ meetingId: "m1", topic: "x.y", t: 1, source: "alice", data: 2 });
  await pipe.drain();
  assert.equal(seen.length, 2);
});

test("publishing to an unknown meeting throws", () => {
  assert.throws(() => pipe.publish({ meetingId: "nope", topic: "x.y", t: 0, source: "a", data: 1 }), /unknown meeting/);
});
