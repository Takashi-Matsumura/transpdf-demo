// pdfjs-dist / tesseract.js の worker・コア資産を public/ に同期する。
// バージョン整合が必須なため、CDNやハードコードURLではなく
// node_modules 内の実ファイルをそのままコピーして参照する方式を取る。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
mkdirSync(publicDir, { recursive: true });

// --- pdfjs-dist ---
const pdfjsDir = path.join(root, "node_modules", "pdfjs-dist");
if (existsSync(pdfjsDir)) {
  cpSync(
    path.join(pdfjsDir, "build", "pdf.worker.min.mjs"),
    path.join(publicDir, "pdf.worker.min.mjs")
  );
  cpSync(path.join(pdfjsDir, "cmaps"), path.join(publicDir, "cmaps"), {
    recursive: true,
  });
  cpSync(
    path.join(pdfjsDir, "standard_fonts"),
    path.join(publicDir, "standard_fonts"),
    { recursive: true }
  );
  // JBIG2/JPX/ICC のデコードは wasm で行われる。未同梱だと getDocument() に
  // wasmUrl を渡せず、スキャンPDF（JBIG2圧縮の白黒画像等）のデコードに失敗して
  // 画像が丸ごと破棄される（Jbig2Error）。*_nowasm_fallback.js も同ディレクトリに
  // あるため、フォルダごとコピーして wasm 初期化失敗時の退避路も確保する。
  cpSync(path.join(pdfjsDir, "wasm"), path.join(publicDir, "wasm"), {
    recursive: true,
  });
  console.log(
    "[copy-vendor-assets] synced pdfjs worker/cmaps/standard_fonts/wasm"
  );
} else {
  console.warn("[copy-vendor-assets] pdfjs-dist not found, skipping.");
}

// --- tesseract.js（テキスト層のないPDF向けOCRフォールバック） ---
const tesseractDir = path.join(root, "node_modules", "tesseract.js");
const tesseractCoreDir = path.join(root, "node_modules", "tesseract.js-core");
if (existsSync(tesseractDir) && existsSync(tesseractCoreDir)) {
  const tesseractPublicDir = path.join(publicDir, "tesseract");
  const corePublicDir = path.join(publicDir, "tesseract-core");
  mkdirSync(tesseractPublicDir, { recursive: true });
  mkdirSync(corePublicDir, { recursive: true });

  cpSync(
    path.join(tesseractDir, "dist", "worker.min.js"),
    path.join(tesseractPublicDir, "worker.min.js")
  );

  // createWorker のデフォルト oem は LSTM_ONLY のため、-lstm 系のコアだけで足りる。
  // 各ファイルは wasm バイナリを内包した自己完結ビルドなので .wasm 本体は不要。
  const coreVariants = [
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
  ];
  for (const file of coreVariants) {
    cpSync(path.join(tesseractCoreDir, file), path.join(corePublicDir, file));
  }
  console.log("[copy-vendor-assets] synced tesseract.js worker/core");
} else {
  console.warn("[copy-vendor-assets] tesseract.js not found, skipping.");
}

// --- tesseract.js の言語データ（traineddata） ---
// 未指定だと実行時に jsDelivr CDN からダウンロードされ、オフライン環境や
// 社内ネットワークからの初回アクセスで失敗する。あらかじめ public/ に
// 同梱し、app/lib/ocr.ts の langPath でそちらを参照させる。
// oem=1（LSTM_ONLY）で使うため、各パッケージの 4.0.0_best_int/ 側を使う
// （langPath を明示すると tesseract.js 側の best_int 自動選択が効かなくなるため、
//  こちらで正しいバリアントを選んでおく必要がある）。
const LANGS = ["vie", "eng", "mya"];
const langPublicDir = path.join(publicDir, "tesseract-lang");
mkdirSync(langPublicDir, { recursive: true });
const copiedLangs = [];
for (const lang of LANGS) {
  const src = path.join(
    root,
    "node_modules",
    "@tesseract.js-data",
    lang,
    "4.0.0_best_int",
    `${lang}.traineddata.gz`
  );
  if (!existsSync(src)) continue;
  cpSync(src, path.join(langPublicDir, `${lang}.traineddata.gz`));
  copiedLangs.push(lang);
}
if (copiedLangs.length > 0) {
  console.log(
    `[copy-vendor-assets] synced tesseract traineddata: ${copiedLangs.join(", ")}`
  );
} else {
  console.warn(
    "[copy-vendor-assets] @tesseract.js-data/* not found, skipping (OCR will fall back to CDN download)."
  );
}
