import type { Pipeline } from "../core/pipeline.ts";
import { estimateSpeechMs, type Scenario } from "./scenario.ts";

// Event contracts the real pipeline must also produce (phase 4 / 6).
export interface TranscriptFinal {
  text: string;
  endT: number; // ms offset where the utterance ended; event.t is its start
}
export interface ScreenText {
  text: string;
  image: string;
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
  for (const line of scenario.script) {
    const base = { meetingId, t: line.at, source: line.who };
    if ("say" in line) {
      const data: TranscriptFinal = { text: line.say, endT: line.at + speechMs(line.who, line.say) };
      pipeline.publish({ ...base, topic: "transcript.final", data });
    } else if ("screen" in line) {
      const data: ScreenText = { text: line.text ?? "", image: line.screen };
      pipeline.publish({ ...base, topic: "screen.text", data });
    } else if ("join" in line) {
      pipeline.publish({ ...base, topic: "presence.join", data: null });
    } else {
      pipeline.publish({ ...base, topic: "presence.leave", data: null });
    }
  }
}
