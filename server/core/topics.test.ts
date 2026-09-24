import assert from "node:assert/strict";
import { test } from "node:test";
import { matchTopic } from "./topics.ts";

test("exact match", () => {
  assert.equal(matchTopic("audio.pcm", "audio.pcm"), true);
  assert.equal(matchTopic("audio.pcm", "audio.utterance"), false);
});

test("* matches exactly one segment", () => {
  assert.equal(matchTopic("screen.*", "screen.frame"), true);
  assert.equal(matchTopic("screen.*", "screen"), false);
  assert.equal(matchTopic("screen.*", "screen.frame.raw"), false);
  assert.equal(matchTopic("*.final", "transcript.final"), true);
});

test("> matches one or more trailing segments", () => {
  assert.equal(matchTopic("audio.>", "audio.pcm"), true);
  assert.equal(matchTopic("audio.>", "audio.vad.start"), true);
  assert.equal(matchTopic("audio.>", "audio"), false);
  assert.equal(matchTopic(">", "anything.at.all"), true);
});
