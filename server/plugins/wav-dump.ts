import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PCM_RATE, type AudioPcm } from "../ingest/scribe.ts";
import type { Plugin } from "../core/types.ts";

// Verification tap: writes each speaker's audio.pcm to
// <dir>/<meetingId>/<participantId>.wav, placed by event time. Every file
// starts at meeting t=0, so all speakers line up in a DAW, and gaps (muted,
// lost packets, late join) are silence. Offsets past EOF leave sparse holes,
// which read back as zeros.

const HEADER = 44;

export function wavDump(dir = "data/recordings"): Plugin {
  const files = new Map<string, { fd: number; end: number }>();

  return {
    name: "wav-dump",
    subscribes: ["audio.pcm"],
    async handle(ev) {
      const key = `${ev.meetingId}/${ev.source}`;
      let f = files.get(key);
      if (!f) {
        mkdirSync(join(dir, ev.meetingId), { recursive: true });
        f = { fd: openSync(join(dir, `${key}.wav`), "w"), end: HEADER };
        files.set(key, f);
      }
      const { samples } = ev.data as AudioPcm;
      const at = HEADER + Math.round((ev.t * PCM_RATE) / 1000) * 2;
      writeSync(f.fd, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 0, samples.byteLength, at);
      if (at + samples.byteLength > f.end) {
        f.end = at + samples.byteLength;
        writeSync(f.fd, wavHeader(f.end - HEADER), 0, HEADER, 0); // keep the file playable at all times
      }
    },
    async close() {
      for (const f of files.values()) closeSync(f.fd);
      files.clear();
    },
  };
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(HEADER);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(PCM_RATE, 24);
  h.writeUInt32LE(PCM_RATE * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
