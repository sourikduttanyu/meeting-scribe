export interface Meeting {
  id: string;
  title: string;
  startedAt: number | null; // epoch ms; null until the first participant joins
  durationMs: number; // fixed length; "first half" etc. resolve against this
}

export interface MeetingEvent<T = unknown> {
  id: string;
  meetingId: string;
  topic: string; // "<domain>.<kind>", e.g. "transcript.final"
  t: number; // ms offset from meeting start, at CAPTURE time (not processing time)
  source: string; // participant id or plugin name
  data: T;
  durable: boolean; // false = delivered to plugins but never written to the log
}

export interface EmitOptions {
  durable?: boolean; // default true
}

export interface EventFilter {
  topic?: string; // pattern, see topics.ts
  from?: number; // inclusive, ms offset
  to?: number; // inclusive, ms offset
}

export type Logger = Pick<Console, "info" | "warn" | "error">;

// Bound to ONE meeting: a plugin handling an event can only read/write that meeting.
export interface PluginContext {
  meeting: Meeting;
  emit<T>(topic: string, t: number, data: T, opts?: EmitOptions): MeetingEvent<T>;
  query(filter?: EventFilter): MeetingEvent[];
  log: Logger;
}

// oldest: drop head when full (freshness matters, e.g. screen frames)
// newest: drop incoming when full
// never:  never drop; warn when over max (speech must not be lost). Real backpressure
//         arrives with a pull-based broker (Redis Streams / Kafka).
export type DropPolicy = "oldest" | "newest" | "never";

export interface Plugin {
  name: string;
  subscribes: string[];
  queue?: { max: number; drop: DropPolicy };
  init?(): Promise<void>;
  handle(ev: MeetingEvent, ctx: PluginContext): Promise<void>;
  close?(): Promise<void>;
}
