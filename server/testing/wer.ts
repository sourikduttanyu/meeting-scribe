// Word error rate for transcripts vs ground truth.
// Normalizes the formatting differences that aren't recognition errors:
// case, punctuation, "12%" vs "twelve percent", "$40,000" vs "forty thousand dollars".

const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

function intWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${intWords(n % 100)}` : ""}`;
  for (const [size, word] of [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const) {
    if (n >= size) return `${intWords(Math.floor(n / size))} ${word}${n % size ? ` ${intWords(n % size)}` : ""}`;
  }
  return String(n);
}

function numberWords(raw: string): string {
  const [int, frac] = raw.replace(/,/g, "").split(".");
  const words = intWords(Number(int));
  return frac ? `${words} point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}` : words;
}

export function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|m|k)?\b/g, (_, n, unit) => `${n} ${unit ? `${{ m: "million", k: "thousand" }[unit as "m" | "k"] ?? unit} ` : ""}dollars `)
    .replace(/(\d)%/g, "$1 percent")
    .replace(/(?<![q\d])\d[\d,]*(?:\.\d+)?/g, (n) => numberWords(n)) // "q3" stays one token
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Levenshtein distance over words / reference length.
export function wer(reference: string, hypothesis: string): { wer: number; errors: number; words: number } {
  const r = normalize(reference);
  const h = normalize(hypothesis);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  const errors = prev[h.length]!;
  return { wer: r.length ? errors / r.length : 0, errors, words: r.length };
}
