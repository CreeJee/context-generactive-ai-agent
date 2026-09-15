// Kiwi (Korean morphological analyzer) in a worker thread: the WASM model needs ~850 MB, so it
// lives here and the main thread can end the worker when it has been idle.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { KiwiBuilder } from "kiwi-nlp";

// Resolved here, next to this file's own dependency, so it works when the caller is bundled.
const wasmPath = join(
  dirname(createRequire(import.meta.url).resolve("kiwi-nlp")),
  "kiwi-wasm.wasm",
);

/** Parts of speech worth searching by: nouns, numerals, verb/adjective stems, roots, Hanja. */
const kept = new Set(["NNG", "NNP", "NR", "VV", "VA", "XR", "SH"]);
const nouns = new Set(["NNG", "NNP"]);
/** Stems that occur in almost every sentence ("하기로 했다", "있다") and only add noise. */
const lightStems = new Set([
  "하",
  "되",
  "있",
  "없",
  "않",
  "같",
  "이",
  "아니",
  "어떻",
  "어떠",
  "그렇",
  "이렇",
  "저렇",
]);
/**
 * Latin words and numbers are taken from the text itself: Kiwi sometimes splits them oddly
 * ("Grafana" → "Gr" + "afana"), and a plain split keeps "drizzle-kit" findable by either half.
 */
const latinOrNumber = /[\p{Script=Latin}\p{Nd}]+/gu;

async function load() {
  const builder = await KiwiBuilder.create(wasmPath);
  const modelFiles = Object.fromEntries(
    readdirSync(workerData.modelDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(workerData.modelDirectory, entry.name))]),
  );
  return builder.build({ modelFiles, modelType: "cong" });
}

function termsOf(kiwi, input) {
  const text = input.normalize("NFKC");
  const terms = [];
  // Compound nouns are split inconsistently ("데이터베이스" vs "데이터 베이스"), so a run of nouns
  // written without spaces also counts as one term.
  let run = [];
  let runEnd = -1;
  const closeRun = () => {
    if (run.length > 1) terms.push(run.join(""));
    run = [];
  };
  for (const token of kiwi.tokenize(text)) {
    const tag = token.tag.replace(/-[RI]$/, "");
    if (nouns.has(tag)) {
      if (token.position !== runEnd) closeRun();
      run.push(token.str);
      runEnd = token.position + token.length;
    } else closeRun();
    const latin = token.str.search(latinOrNumber) >= 0;
    if (kept.has(tag) && !lightStems.has(token.str) && !latin) terms.push(token.str);
  }
  closeRun();
  for (const [word] of text.matchAll(latinOrNumber)) terms.push(word);
  return terms.map((term) => term.toLowerCase());
}

const ready = load().then(
  (kiwi) => ({ kiwi }),
  (error) => ({ error: String(error) }),
);

parentPort.on("message", async ({ id, texts }) => {
  const state = await ready;
  if (state.error) return parentPort.postMessage({ id, kind: "error", error: state.error });
  try {
    const terms = texts.map((text) => termsOf(state.kiwi, text));
    parentPort.postMessage({ id, kind: "terms", terms });
  } catch (error) {
    parentPort.postMessage({ id, kind: "error", error: String(error) });
  }
});
