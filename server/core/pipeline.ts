import { randomUUID } from "node:crypto";
import type { EventLog } from "./log.ts";
import { matchTopic } from "./topics.ts";
import type { EmitOptions, Logger, Meeting, MeetingEvent, Plugin, PluginContext } from "./types.ts";

export interface PublishInput<T = unknown> {
  meetingId: string;
  topic: string;
  t: number;
  source: string;
  data: T;
}

interface Subscription {
  plugin: Plugin;
  queue: MeetingEvent[];
  max: number;
  drop: "oldest" | "newest" | "never";
  dropped: number;
  overMax: boolean;
  pump: Promise<void> | null;
}

const DEFAULT_QUEUE = { max: 1000, drop: "never" as const };

// In-process event bus + plugin host.
// Write path: publish → append to log (if durable) → fan out to each matching
// plugin's own FIFO queue. Each plugin processes its queue serially, so a slow
// plugin only delays itself, and every plugin sees events in publish order.
export class Pipeline {
  #log: EventLog;
  #logger: Logger;
  #subs: Subscription[] = [];
  #meetings = new Map<string, Meeting>();

  constructor(log: EventLog, logger: Logger = console) {
    this.#log = log;
    this.#logger = logger;
  }

  async use(plugin: Plugin): Promise<void> {
    await plugin.init?.();
    const q = plugin.queue ?? DEFAULT_QUEUE;
    this.#subs.push({ plugin, queue: [], max: q.max, drop: q.drop, dropped: 0, overMax: false, pump: null });
  }

  publish<T>(input: PublishInput<T>, opts: EmitOptions = {}): MeetingEvent<T> {
    this.#meeting(input.meetingId); // reject unknown meetings early
    const ev: MeetingEvent<T> = { id: randomUUID(), ...input, durable: opts.durable ?? true };
    if (ev.durable) this.#log.append(ev);
    for (const sub of this.#subs) {
      if (sub.plugin.name === ev.source) continue; // no self-delivery → no feedback loops
      if (sub.plugin.subscribes.some((p) => matchTopic(p, ev.topic))) this.#enqueue(sub, ev);
    }
    return ev;
  }

  // Resolves once every queue is empty, including events emitted while draining.
  async drain(): Promise<void> {
    for (;;) {
      const running = this.#subs.flatMap((s) => (s.pump ? [s.pump] : []));
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  stats(): { plugin: string; queued: number; dropped: number }[] {
    return this.#subs.map((s) => ({ plugin: s.plugin.name, queued: s.queue.length, dropped: s.dropped }));
  }

  async close(): Promise<void> {
    await this.drain();
    for (const s of this.#subs) await s.plugin.close?.();
  }

  #meeting(id: string): Meeting {
    let m = this.#meetings.get(id);
    if (!m) {
      m = this.#log.getMeeting(id);
      if (!m) throw new Error(`unknown meeting: ${id}`);
      if (m.startedAt !== null) this.#meetings.set(id, m); // only cache once immutable
    }
    return m;
  }

  #enqueue(sub: Subscription, ev: MeetingEvent): void {
    if (sub.queue.length >= sub.max) {
      if (sub.drop === "newest") {
        sub.dropped++;
        return;
      }
      if (sub.drop === "oldest") {
        sub.queue.shift();
        sub.dropped++;
      } else if (!sub.overMax) {
        sub.overMax = true;
        this.#logger.warn(`[pipeline] ${sub.plugin.name} queue over max (${sub.max}); not dropping`);
      }
    }
    sub.queue.push(ev);
    sub.pump ??= this.#pump(sub);
  }

  async #pump(sub: Subscription): Promise<void> {
    // Yield once so publish() stays synchronous for the caller.
    await Promise.resolve();
    while (sub.queue.length > 0) {
      const ev = sub.queue.shift()!;
      try {
        await sub.plugin.handle(ev, this.#context(sub.plugin.name, ev.meetingId));
      } catch (err) {
        this.#logger.error(`[pipeline] ${sub.plugin.name} failed on ${ev.topic}`, err);
      }
    }
    sub.overMax = false;
    sub.pump = null;
  }

  #context(source: string, meetingId: string): PluginContext {
    return {
      meeting: this.#meeting(meetingId),
      emit: (topic, t, data, opts) => this.publish({ meetingId, topic, t, source, data }, opts),
      query: (filter) => this.#log.query(meetingId, filter),
      log: this.#logger,
    };
  }
}
