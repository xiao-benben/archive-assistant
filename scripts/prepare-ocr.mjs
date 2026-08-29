import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(project, "public", "ocr");
mkdirSync(target, { recursive: true });

const assets = [
  ["node_modules/tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm", "tesseract-core-simd-lstm.wasm"],
  ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz", "chi_sim.traineddata.gz"],
  ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "eng.traineddata.gz"],
];

for (const [source, name] of assets) cpSync(resolve(project, source), resolve(target, name));
console.log(`Prepared ${assets.length} offline OCR assets.`);
