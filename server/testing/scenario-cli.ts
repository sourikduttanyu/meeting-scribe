// Usage: npm run scenario -- scenarios/budget-review.json
// Validates a scenario, renders every line's voice, replays it with the L0 bot
// into data/<name>.sqlite, and prints the resulting timeline.
import { mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { EventLog } from "../core/log.ts";
import { Pipeline } from "../core/pipeline.ts";
import { runL0 } from "./l0-bot.ts";
import { loadScenario } from "./scenario.ts";
import { renderSpeech } from "./tts.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run scenario -- <scenario.json>");
  process.exit(1);
}
const scenario = loadScenario(file);
const voices = new Map(scenario.participants.map((p) => [p.id, p.voice]));

// Real rendered durations make L0's endT match what L1+ will observe.
const durations = new Map<string, number>();
let rendered = 0;
for (const line of scenario.script) {
  if (!("say" in line)) continue;
  const r = renderSpeech(voices.get(line.who)!, line.say);
  durations.set(`${line.who}\n${line.say}`, r.durationMs);
  if (!r.cached) rendered++;
}
console.log(`voices: ${durations.size} lines (${rendered} rendered, ${durations.size - rendered} cached)`);

const name = basename(file, ".json");
mkdirSync("data", { recursive: true });
rmSync(`data/${name}.sqlite`, { force: true });
const log = new EventLog(`data/${name}.sqlite`);
log.createMeeting({ id: name, title: scenario.title, startedAt: Date.now(), durationMs: scenario.durationMs });
const pipeline = new Pipeline(log);
runL0(scenario, pipeline, name, (who, text) => durations.get(`${who}\n${text}`)!);
await pipeline.close();

const mmss = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
for (const ev of log.query(name)) {
  const d = ev.data as { text?: string } | null;
  console.log(`${mmss(ev.t)}  ${ev.source.padEnd(6)} ${ev.topic.padEnd(17)} ${d?.text ?? ""}`);
}
log.close();
console.log(`\nwrote data/${name}.sqlite`);
