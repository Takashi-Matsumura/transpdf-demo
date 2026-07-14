import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // pdfjs-dist / tesseract.js からコピーした静的アセット（lint対象外）
    "public/pdf.worker.min.mjs",
    "public/cmaps/**",
    "public/standard_fonts/**",
    "public/tesseract/**",
    "public/tesseract-core/**",
  ]),
]);

export default eslintConfig;
