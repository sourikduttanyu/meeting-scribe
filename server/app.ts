import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { EventLog } from "./core/log.ts";
import { Pipeline } from "./core/pipeline.ts";
import { Signaling } from "./signaling.ts";

const WEB_ROOT = resolve("web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const MIN_DURATION = 60_000;
const MAX_DURATION = 4 * 60 * 60_000;

export interface AppOptions {
  port?: number;
  dbPath?: string;
  dev?: boolean; // enables /dev/* routes (test bots)
}

export interface App {
  url: string;
  server: Server;
  log: EventLog;
  pipeline: Pipeline;
  signaling: Signaling;
  close(): Promise<void>;
}

export async function startApp(opts: AppOptions = {}): Promise<App> {
  const log = new EventLog(opts.dbPath);
  const endTimers = new Set<NodeJS.Timeout>();
  const pipeline = new Pipeline(log);
  const signaling = new Signaling({
    getMeeting: (id) => log.getMeeting(id),
    startMeeting: (id) => {
      const meeting = log.startMeeting(id, Date.now())!;
      const timer = setTimeout(() => {
        endTimers.delete(timer);
        signaling.end(meeting.id);
      }, meeting.startedAt! + meeting.durationMs - Date.now());
      endTimers.add(timer);
      return meeting;
    },
    // Ingest edge: the only place wall clock becomes event time.
    onPresence: (meeting, peer, kind) =>
      pipeline.publish({
        meetingId: meeting.id,
        topic: `presence.${kind}`,
        t: Date.now() - meeting.startedAt!, // participants only join started meetings
        source: peer.id,
        data: { name: peer.name, bot: peer.bot },
      }),
  });
  const bots: { close(): Promise<void> }[] = [];

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/api/meetings") {
      const body = (await readJson(req)) as { title?: string; durationMs?: number };
      const durationMs = Number(body.durationMs);
      if (!(durationMs >= MIN_DURATION && durationMs <= MAX_DURATION)) {
        return json(res, 400, { error: `durationMs must be ${MIN_DURATION}..${MAX_DURATION}` });
      }
      const meeting = {
        id: randomUUID().slice(0, 8),
        title: String(body.title || "Untitled meeting").slice(0, 120),
        startedAt: null, // clock starts at first participant join
        durationMs,
      };
      log.createMeeting(meeting);
      return json(res, 201, meeting);
    }

    const m = url.pathname.match(/^\/api\/meetings\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const meeting = log.getMeeting(m[1]!);
      return meeting ? json(res, 200, meeting) : json(res, 404, { error: "not found" });
    }

    if (opts.dev && req.method === "GET" && url.pathname === "/dev/ping") return json(res, 200, { dev: true });

    const bot = url.pathname.match(/^\/dev\/meetings\/([\w-]+)\/bots$/);
    if (opts.dev && req.method === "POST" && bot) {
      const { launchBot } = await import("./testing/l3-bot.ts"); // dev-only dependency
      const b = await launchBot({ baseUrl: appUrl(), meetingId: bot[1]!, name: `bot-${bots.length + 1}` });
      bots.push(b);
      return json(res, 201, { name: b.name });
    }

    if (req.method === "GET") return serveStatic(url.pathname, res);
    json(res, 404, { error: "not found" });
  }

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 256 * 1024 });
  wss.on("connection", (ws) => {
    const handlers = signaling.connect({ send: (d) => ws.send(d), close: () => ws.close() });
    ws.on("message", (raw) => handlers.onMessage(raw.toString()));
    ws.on("close", () => handlers.onClose());
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, r));
  const appUrl = () => `http://localhost:${(server.address() as AddressInfo).port}`;

  return {
    url: appUrl(),
    server,
    log,
    pipeline,
    signaling,
    async close() {
      for (const t of endTimers) clearTimeout(t);
      await Promise.all(bots.map((b) => b.close()));
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
      await pipeline.close();
      log.close();
    },
  };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const file = resolve(join(WEB_ROOT, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(WEB_ROOT + "/")) return json(res, 403, { error: "forbidden" }); // path traversal guard
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error("body too large");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
