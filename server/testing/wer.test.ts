import assert from "node:assert/strict";
import { test } from "node:test";
import { normalize, wer } from "./wer.ts";

test("normalize: formatting differences are not errors", () => {
  assert.deepEqual(normalize("Marketing spend went up 12%."), normalize("marketing spend went up twelve percent"));
  assert.deepEqual(normalize("We had about $40,000 left."), normalize("we had about forty thousand dollars left"));
  assert.deepEqual(normalize("we closed at 4.2 million"), normalize("we closed at four point two million"));
  assert.deepEqual(normalize("$4.2M in Q3"), normalize("four point two million dollars in q3"));
  assert.deepEqual(normalize("return 10,000 to contingency"), normalize("return ten thousand to contingency"));
});

test("wer: substitutions, insertions, deletions", () => {
  assert.equal(wer("the cat sat", "the cat sat").wer, 0);
  assert.equal(wer("the cat sat", "the bat sat").errors, 1);
  assert.equal(wer("the cat sat", "the cat sat down").errors, 1);
  assert.equal(wer("the cat sat", "cat sat").errors, 1);
  assert.equal(wer("one two three four", "").wer, 1);
});
