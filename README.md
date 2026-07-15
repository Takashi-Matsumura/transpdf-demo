# 外国語PDF 日本語オーバーレイ翻訳

外国語（主にベトナム語）のPDFをアップロードすると、常駐しているローカルLLM（[llama.cpp](https://github.com/ggml-org/llama.cpp) + gemma-4-12b）が日本語に翻訳し、元のレイアウトの上に日本語訳を重ねて表示するデモアプリです。翻訳はすべてローカルで完結し、外部のクラウドAPIへPDF本文が送信されることはありません。

## 特徴

- **オーバーレイ表示**: PDFを`pdfjs-dist`でcanvasに描画し、抽出したテキストの座標に合わせて日本語訳を重ねて表示します。原文の位置関係やレイアウトを保ったまま読めます。
- **テキスト層 / OCR 自動判定**: PDFにテキスト層があればそのまま抽出し、スキャン画像などテキスト層を持たないPDFは自動的に[tesseract.js](https://github.com/naptha/tesseract.js)によるOCR（ベトナム語+日本語）にフォールバックします。
- **OCRエリアの手動指定**: 自動OCRから漏れた項目は、PDF表示上でマウスドラッグして範囲を追加指定できます。指定した範囲だけを高解像度でOCR・翻訳し、オーバーレイに追加します。
- **再翻訳・翻訳結果の削除**: 翻訳済みのボックスにマウスをホバーすると「再翻訳」「削除」ボタンが表示されます。文字化けなど訳が不適切な場合はその場で送り直せるほか、削除してOCRエリア指定で範囲を囲み直すことでも再翻訳できます。
- **表形式に対応**: 単語・テキスト断片の水平方向の隙間からセル境界を推定し、表の列同士が混ざらないようセル単位で翻訳します。
- **ローカルLLM連携**: OpenAI互換API（`/v1/chat/completions`）でllama.cppサーバーに1行ずつ翻訳をリクエストします。タイムアウト・リトライを行い、翻訳に失敗した行は原文表示にフォールバックします。
- **既存の日本語訳を保護**: 対訳PDFなど、原文の隣にすでに日本語訳が印字されている場合は二重翻訳せず、そのまま参照として残します。
- **表示調整**: 原文⇄訳のトグル切り替え、拡大縮小（50%〜300%）、ドラッグ＆ドロップでのPDF読み込みに対応しています。

## セットアップ

### 前提: ローカルLLMサーバー

このPCに常駐する llama.cpp サーバー（OpenAI互換API）が必要です。既定では以下を想定しています。

- エンドポイント: `http://127.0.0.1:8080`
- モデル: `gemma-4-12b-it-Q4_K_M.gguf`

エンドポイントを変更する場合は `.env.local` に以下を設定してください。

```bash
LLAMA_BASE_URL=http://127.0.0.1:8080
```

### インストールと起動

```bash
npm install
npm run dev
```

`npm install` / `npm run dev` 時に `scripts/copy-pdfjs-assets.mjs` が自動実行され、`pdfjs-dist` のworker/フォントと `tesseract.js` のworker/コアを `public/` に同期します。

[http://localhost:3000](http://localhost:3000) を開き、PDFをアップロードして翻訳結果を確認できます。

## 使い方

1. **PDFを読み込む**: 「PDFをアップロード」ボタンから選択するか、画面下部のエリアへドラッグ＆ドロップします。
2. **自動翻訳を確認する**: テキスト層またはOCRで抽出した項目が順にローカルLLMで翻訳されます。黄色（翻訳待ち）→ 水色（翻訳完了）/ オレンジ（翻訳失敗・原文のまま）の順で状態が変わります。
3. **漏れを補う**: 「OCRエリア指定」を有効にし、自動抽出で拾えなかった箇所をマウスドラッグで囲むと、その範囲を追加でOCR・翻訳します。
4. **誤りを直す**: 翻訳済みのボックスにマウスを乗せると表示される「再翻訳」「削除」ボタンで、訳をやり直したり、削除してから範囲を指定し直したりできます。

## 技術スタック

- Next.js 16 (App Router) / React 19 / TypeScript / Tailwind CSS v4
- [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) — PDF描画・テキスト座標抽出
- [tesseract.js](https://www.npmjs.com/package/tesseract.js) — OCR（テキスト層のないPDF・手動指定エリア向け）
- ローカルLLM（llama.cpp, OpenAI互換API）— 翻訳

## 主なディレクトリ構成

```
app/
  api/translate/route.ts       # ローカルLLMへの翻訳リクエスト（Route Handler）
  components/
    PdfTranslatorApp.tsx       # 状態管理・アップロードUI・ズーム・OCRエリア指定/再翻訳の操作
    PdfOverlayViewer.tsx       # PDF描画・オーバーレイ表示・手動選択レイヤー
  lib/
    pdf.ts                     # pdfjs読み込み・テキスト抽出・セル分割
    ocr.ts                     # tesseract.js によるOCRフォールバック・手動エリアOCR
    translate-client.ts        # 翻訳APIのチャンク分割・呼び出し
    types.ts                   # 共有型定義
scripts/
  copy-pdfjs-assets.mjs        # pdfjs-dist / tesseract.js の資産を public/ に同期
```

## ライセンス

[MIT License](./LICENSE)
