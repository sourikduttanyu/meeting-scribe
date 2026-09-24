import { DatabaseSync } from "node:sqlite";
import { matchTopic } from "./topics.ts";
import type { EventFilter, Meeting, MeetingEvent } from "./types.ts";

// Append-only event log: the source of truth for a meeting. Plugins are
// derived views over it, so any new plugin can be replayed over old meetings.
export class EventLog {
  #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        started_at INTEGER,
        duration_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        topic TEXT NOT NULL,
        t INTEGER NOT NULL,
        source TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_meeting_t ON events(meeting_id, t);
    `);
  }

  createMeeting(m: Meeting): void {
    this.#db
      .prepare("INSERT INTO meetings (id, title, started_at, duration_ms) VALUES (?, ?, ?, ?)")
      .run(m.id, m.title, m.startedAt, m.durationMs);
  }

  // Idempotent: only the first call sets the start time.
  startMeeting(id: string, at: number): Meeting | undefined {
    this.#db.prepare("UPDATE meetings SET started_at = ? WHERE id = ? AND started_at IS NULL").run(at, id);
    return this.getMeeting(id);
  }

  getMeeting(id: string): Meeting | undefined {
    const row = this.#db
      .prepare("SELECT id, title, started_at, duration_ms FROM meetings WHERE id = ?")
      .get(id) as { id: string; title: string; started_at: number | null; duration_ms: number } | undefined;
    return row && { id: row.id, title: row.title, startedAt: row.started_at, durationMs: row.duration_ms };
  }

  append(ev: MeetingEvent): void {
    this.#db
      .prepare("INSERT INTO events (id, meeting_id, topic, t, source, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ev.id, ev.meetingId, ev.topic, ev.t, ev.source, JSON.stringify(ev.data));
  }

  // Ordered by capture time, ties broken by arrival order.
  query(meetingId: string, filter: EventFilter = {}): MeetingEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT id, meeting_id, topic, t, source, data FROM events
         WHERE meeting_id = ? AND t >= ? AND t <= ?
         ORDER BY t, seq`,
      )
      .all(meetingId, filter.from ?? 0, filter.to ?? Number.MAX_SAFE_INTEGER) as {
      id: string;
      meeting_id: string;
      topic: string;
      t: number;
      source: string;
      data: string;
    }[];
    const events = rows.map((r) => ({
      id: r.id,
      meetingId: r.meeting_id,
      topic: r.topic,
      t: r.t,
      source: r.source,
      data: JSON.parse(r.data) as unknown,
      durable: true,
    }));
    const pattern = filter.topic;
    return pattern ? events.filter((e) => matchTopic(pattern, e.topic)) : events;
  }

  close(): void {
    this.#db.close();
  }
}
