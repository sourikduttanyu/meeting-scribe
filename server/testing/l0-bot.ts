import type { Pipeline } from "../core/pipeline.ts";
import { estimateSpeechMs, type Scenario } from "./scenario.ts";

// Event contracts the real pipeline must also produce (phase 4 / 6).
export interface TranscriptFinal {
  speaker: string; // participantId (the event's source is whichever stage produced it)
  text: string;
  endT: number; // ms offset where the utterance ended; event.t is its start
}
export interface ScreenText {
  text: string;
  image: string;
}
export interface Presence {
  name: string;
  bot: boolean;
}

// L0 bot: skips media entirely and publishes what the ASR/OCR stages WOULD
// emit, stamped with scenario time. No wall clock → a 2 h meeting replays
// instantly. Used to test everything downstream of transcription.
export function runL0(
  scenario: Scenario,
  pipeline: Pipeline,
  meetingId: string,
  speechMs: (who: string, text: string) => number = (_w, text) => estimateSpeechMs(text),
): void {
  const names = new Map(scenario.participants.map((p) => [p.id, p.name ?? p.id]));
  for (const line of scenario.script) {
    const base = { meetingId, t: line.at, source: line.who };
    if ("say" in line) {
      const data: TranscriptFinal = { speaker: line.who, text: line.say, endT: line.at + speechMs(line.who, line.say) };
      pipeline.publish({ ...base, topic: "transcript.final", data });
    } else if ("screen" in line) {
      const data: ScreenText = { text: line.text ?? "", image: line.screen };
      pipeline.publish({ ...base, topic: "screen.text", data });
    } else {
      const data: Presence = { name: names.get(line.who)!, bot: true };
      pipeline.publish({ ...base, topic: "join" in line ? "presence.join" : "presence.leave", data });
    }
  }
}
