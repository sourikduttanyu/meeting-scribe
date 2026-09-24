import { readFileSync } from "node:fs";

// A scripted meeting: the single source of ground truth for every bot level
// (L0 events, L1 audio, L2 WebRTC, L3 browser) and for eval checks.

export interface Participant {
  id: string;
  name?: string;
  voice: string; // macOS `say -v` voice, e.g. "Samantha"
}

export type ScriptLine =
  | { at: number; who: string; say: string }
  | { at: number; who: string; screen: string; text?: string } // text = ground truth for L0
  | { at: number; who: string; join: true }
  | { at: number; who: string; leave: true };

export interface Check {
  ask: string;
  mustMention?: string[];
  mustNotMention?: string[];
}

export interface Scenario {
  title: string;
  durationMs: number;
  participants: Participant[];
  script: ScriptLine[];
  checks?: Check[];
}

export function loadScenario(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, "utf8")));
}

export function parseScenario(raw: unknown): Scenario {
  const s = raw as Scenario;
  const errors: string[] = [];
  if (typeof s?.title !== "string") errors.push("title must be a string");
  if (!(s?.durationMs > 0)) errors.push("durationMs must be > 0");
  if (!Array.isArray(s?.participants) || s.participants.length === 0) errors.push("participants required");
  if (!Array.isArray(s?.script)) errors.push("script must be an array");
  if (errors.length) throw new Error(`invalid scenario: ${errors.join("; ")}`);

  const ids = new Set(s.participants.map((p) => p.id));
  if (ids.size !== s.participants.length) errors.push("participant ids must be unique");
  let prev = 0;
  s.script.forEach((line, i) => {
    const actions = ["say", "screen", "join", "leave"].filter((k) => k in line);
    if (actions.length !== 1) errors.push(`script[${i}]: exactly one of say|screen|join|leave`);
    if (!ids.has(line.who)) errors.push(`script[${i}]: unknown participant "${line.who}"`);
    if (!(line.at >= 0 && line.at <= s.durationMs)) errors.push(`script[${i}]: at outside 0..durationMs`);
    if (line.at < prev) errors.push(`script[${i}]: lines must be sorted by at`);
    prev = line.at;
  });
  if (errors.length) throw new Error(`invalid scenario: ${errors.join("; ")}`);
  return s;
}

// Rough speech duration when no audio was rendered (~150 wpm).
export function estimateSpeechMs(text: string): number {
  return Math.round((text.trim().split(/\s+/).length / 150) * 60_000);
}
