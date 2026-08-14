// テキスト層を持たない（スキャン/画像ベースの）PDFのためのOCRフォールバック。
// tesseract.js は必ずブラウザ側の呼び出しからのみ使う（動的import + useEffect経由）。
import type { Page, Worker } from "tesseract.js";
import { buildLineGroups, detectSourceLang, isTranslatable } from "./pdf";
import type { RawItem } from "./pdf";
import type { LineGroup, PageRotation, SourceLang } from "./types";

/**
 * 原文言語が確定したときに実際にOCRへ渡すtesseract言語セット。
 * 単独指定より「該当語＋英語」の方が精度が高い（実測: ミャンマー語の
 * 会社設立証明書で mya単独 confidence 44 → mya+eng で 72）。
 * vie/eng は対訳PDF（原文の隣に既存の日本語訳が印字されている）を
 * 誤って二重翻訳しないよう jpn も読む。ミャンマー語の公文書は日本語対訳が
 * 実質無いため jpn は含めず、代わりに英語併記に備える。
 */
const OCR_LANGS: Record<SourceLang, string[]> = {
  vie: ["vie", "jpn"],
  eng: ["eng", "jpn"],
  mya: ["mya", "eng"],
};

/**
 * 原文言語が未確定のときに使う、判定兼用のOCR言語セット。
 * vie/eng の traineddata はミャンマー文字のコードポイントを一切出力できないため、
 * 「vie+engで読んで駄目そうならmyaで読み直す」という手順は原理的に成立しない。
 * 1回目から候補となる全スクリプトを読ませる必要がある（実測でも3言語同時で
 * 精度は落ちない: confidence 73、300dpi 1ページで約2秒）。
 * jpn は判定に寄与しないため外し、言語確定後の本OCRでのみ読む。
 */
const PROBE_LANGS = ["mya", "vie", "eng"];

/**
 * OCR結果が文字として読み取れていない（記号・数字が大半を占める）行を検出する。
 * こうした断片をLLMに投げると、モデルが解釈できず出力が長時間化・暴走しやすいため、
 * 事前に弾いて翻訳をスキップする。
 *
 * \p{L}（文字）だけでなく \p{M}（結合記号）も文字として数える。ミャンマー語は
 * 母音記号・medial・asat等の結合記号が文字数の約半分を占めるため、\p{L}だけで
 * 判定すると正しく認識できた行までゴミ扱いされてしまう
 * （実測: 正しく読めたミャンマー語4行中3行が \p{L} のみの判定だと0.5未満で除外された）。
 */
function looksLikeOcrGarbage(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  const letterCount = (stripped.match(/[\p{L}\p{M}]/gu) ?? []).length;
  return letterCount / stripped.length < 0.5;
}

// tesseract.js のワーカーは生成コストが高い（コアwasmのインスタンス化）ため、
// 言語を切り替えるたびに新規作成せず、1つのワーカーを reinitialize で使い回す。
let workerPromise: Promise<Worker> | null = null;
// ワーカーに現在initialize済みの言語（"mya+eng" 形式）。
let workerLangs = "";

// reinitialize と recognize は別々のジョブとしてワーカーへ送られ、ワーカー側は
// 受信順（FIFO）に処理する。await の合間に別の呼び出しが割り込むと
// 「Aで初期化→Bで初期化→Aのつもりで認識」の順になり、意図しない言語で
// 認識してしまう。全OCRジョブをこのチェーンで直列化して防ぐ。
let ocrQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = ocrQueue.then(job, job);
  // 前のジョブの失敗で後続が止まらないよう、チェーン自体は握りつぶす。
  ocrQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function getWorker(langs: string[]): Promise<Worker> {
  const key = langs.join("+");
  if (!workerPromise) {
    workerPromise = import("tesseract.js")
      .then(({ createWorker }) =>
        createWorker(langs, 1, {
          // ブラウザ既定はCDN参照のため、public/ に同期した実ファイルを明示する。
          workerPath: "/tesseract/worker.min.js",
          corePath: "/tesseract-core",
          langPath: "/tesseract-lang",
        })
      )
      .catch((e) => {
        // 失敗したPromiseをキャッシュしたままだと、リロードするまで復旧できなくなる。
        // 破棄して次回の呼び出しでやり直せるようにする。
        workerPromise = null;
        workerLangs = "";
        throw e;
      });
    workerLangs = key;
    return workerPromise;
  }

  const worker = await workerPromise;
  if (workerLangs !== key) {
    // ワーカーを作り直さず言語だけ切り替える。既に読み込み済みの言語は
    // reinitialize 内部で再取得されない（tesseract.js が差分ロードする）。
    // reinitialize は createWorker と異なり配列を受け付けないため "+" 連結文字列で渡す。
    await worker.reinitialize(key, 1);
    workerLangs = key;
  }
  return worker;
}

function wordsToRawItems(data: Page, toDisplayScale: number): RawItem[] {
  const raw: RawItem[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          raw.push({
            text,
            left: x0 * toDisplayScale,
            top: y0 * toDisplayScale,
            right: x1 * toDisplayScale,
            bottom: y1 * toDisplayScale,
            fontHeight: (y1 - y0) * toDisplayScale,
            angle: 0,
          });
        }
      }
    }
  }
  return raw;
}

/** orientationScore が「この語は読めている」と数えるための最低信頼度(0-100)。 */
const MIN_WORD_CONFIDENCE = 60;
/** この値以上のスコアが出た時点で、以降の角度を試さず正立(0°)と確定する（短絡判定）。 */
const SHORTCIRCUIT_SCORE = 40;
/** 4角度すべてのスコアがこれ未満なら「そもそも文字が無いページ（白紙・図版）」とみなし、
 *  誤って回転させないよう0°を返す。 */
const MIN_ROTATION_SCORE = 5;

/**
 * OCR結果が「その向きでどれだけよく読めたか」を表すスコア。
 * data.confidence（全体平均信頼度）は誤った向きでも一部の記号・数字が
 * 偶然高信頼で読めて高止まりすることがあるため単独では使えない。
 * 代わりに「高信頼度で読め、かつゴミ判定を通った語」の文字数を信頼度で
 * 重み付けして合計する。読めた語が多いほど、また確信度が高いほどスコアが伸びる。
 */
function orientationScore(data: Page): number {
  let score = 0;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text || looksLikeOcrGarbage(text)) continue;
          if (word.confidence < MIN_WORD_CONFIDENCE) continue;
          score += (word.confidence / 100) * text.length;
        }
      }
    }
  }
  return score;
}

// 90度倍数の回転はピクセルの並べ替えだけで済む（補間による劣化が無い）ため、
// PDFを再renderせず2Dキャンバス操作で作る方が安い。
function rotateCanvas(source: HTMLCanvasElement, degrees: 90 | 180 | 270): HTMLCanvasElement {
  const swapDims = degrees === 90 || degrees === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swapDims ? source.height : source.width;
  canvas.height = swapDims ? source.width : source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasコンテキストの取得に失敗しました");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/**
 * スキャン画像の中身自体が回転しているページを検出する。
 * PDFの/Rotateメタデータとは無関係に、0/90/180/270°で低解像度OCRを試し、
 * 最もよく読める向きを採用する（Tesseract Legacyコア・osd.traineddataが要る
 * OSD機能は使わず、既存のLSTMコア・言語データだけで完結させる）。
 *
 * 0°を先に試し、十分なスコアが出れば残り3角度をスキップする（大半のページは
 * 正立なので、追加コストは1回のOCRのみで済む）。全角度が閾値未満（白紙・図版等、
 * そもそも文字が無いページ）の場合は誤って回転させないよう0°を返す。
 *
 * canvas は呼び出し側が用意した低解像度（検出専用）のもの。この関数は内部で
 * 生成した回転済み一時canvasを解放するが、引数のcanvas自体の解放は呼び出し側の責務。
 */
export async function detectPageRotation(
  canvas: HTMLCanvasElement,
  sourceLang: SourceLang | null
): Promise<PageRotation> {
  return enqueue(async () => {
    const langs = sourceLang ? OCR_LANGS[sourceLang] : PROBE_LANGS;
    const worker = await getWorker(langs);

    let best: PageRotation = 0;
    let bestScore = -Infinity;

    const { data: baseline } = await worker.recognize(canvas, {}, { blocks: true });
    bestScore = orientationScore(baseline);

    if (bestScore < SHORTCIRCUIT_SCORE) {
      // 発生頻度順（縦向きスキャンは90°回転の方が180°より一般的）に残りを試す。
      for (const degrees of [90, 270, 180] as const) {
        const rotated = rotateCanvas(canvas, degrees);
        try {
          const { data } = await worker.recognize(rotated, {}, { blocks: true });
          const score = orientationScore(data);
          if (score > bestScore) {
            bestScore = score;
            best = degrees;
          }
        } finally {
          rotated.width = 0;
          rotated.height = 0;
        }
      }
    }

    return bestScore >= MIN_ROTATION_SCORE ? best : 0;
  });
}

export type OcrResult = {
  groups: LineGroup[];
  /** OCR結果の文字種比率から推定した原文の言語。判定材料が乏しい場合はnull。 */
  detected: SourceLang | null;
  /** tesseractの平均信頼度(0-100)。低信頼度時の警告表示に使う。 */
  confidence: number;
  /** 実際に使ったtesseract言語セット（"mya+eng" 形式）。 */
  usedLangs: string;
};

/**
 * canvas（OCR用に高解像度でレンダリングしたもの）をOCRし、セル単位のLineGroupを返す。
 * bbox は canvas のピクセル座標なので、表示用ビューポートとの縮尺差を toDisplayScale で補正する。
 *
 * Tesseractの行（line）単位のテキストをそのまま1つの翻訳対象にすると、
 * 表の複数列（例:「口座番号」「支店」「金額」）が1つの文字列に結合されてしまい、
 * 翻訳結果が読みにくくなる。そこで単語（word）単位のbboxまで分解し、
 * pdfjsのテキスト層と同じ「行内の水平ギャップでセル分割する」ロジックに通す。
 *
 * sourceLang が null（未確定）の場合は PROBE_LANGS で判定兼用のOCRを行う。
 * pageIndex は複数ページPDFでのid名前空間分離・LineGroup.pageIndex付与に使う。
 */
export async function runOcr(
  canvas: HTMLCanvasElement,
  toDisplayScale: number,
  sourceLang: SourceLang | null,
  pageIndex: number
): Promise<OcrResult> {
  return enqueue(async () => {
    const langs = sourceLang ? OCR_LANGS[sourceLang] : PROBE_LANGS;
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(canvas, {}, { blocks: true });

    const raw = wordsToRawItems(data, toDisplayScale);
    const groups = buildLineGroups(raw, {
      joiner: " ",
      idPrefix: `p${pageIndex}-ocr-`,
      pageIndex,
    });
    const filtered = groups.map((g) => ({
      ...g,
      translatable: g.translatable && !looksLikeOcrGarbage(g.text),
    }));

    const sample = filtered
      .filter((g) => g.translatable)
      .map((g) => g.text)
      .join(" ");

    return {
      groups: filtered,
      detected: detectSourceLang(sample),
      confidence: data.confidence,
      usedLangs: langs.join("+"),
    };
  });
}

/**
 * ユーザーが手動指定した領域（OCR用に高解像度でクロップしたcanvas）をOCRし、
 * 認識した全単語を1つのテキスト・1つのbboxにまとめた単一のLineGroupを返す。
 *
 * 自動OCR（runOcr）がセル単位に細かく分割するのに対し、こちらは
 * 「ユーザーが囲んだ範囲＝1つの翻訳単位」という意図に合わせて範囲全体を1つにまとめる。
 *
 * bbox は切り出しcanvasの原点基準なので、toDisplayScale で表示座標に戻したうえで
 * 選択領域左上の offset（表示座標）を加算してページ絶対座標に合わせる。
 * 文字が拾えない／翻訳対象でない場合は null を返す（呼び出し側で無視する）。
 * pageIndex はこの領域が属するページ番号（LineGroup.pageIndexに付与する）。
 */
export async function runOcrRegion(
  canvas: HTMLCanvasElement,
  toDisplayScale: number,
  offset: { left: number; top: number },
  id: string,
  sourceLang: SourceLang | null,
  pageIndex: number
): Promise<LineGroup | null> {
  return enqueue(async () => {
    const langs = sourceLang ? OCR_LANGS[sourceLang] : PROBE_LANGS;
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(canvas, {}, { blocks: true });

    const words: string[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs) {
        for (const line of paragraph.lines) {
          for (const word of line.words) {
            const text = word.text.trim();
            if (!text) continue;
            words.push(text);
            const { x0, y0, x1, y1 } = word.bbox;
            if (x0 < minX) minX = x0;
            if (y0 < minY) minY = y0;
            if (x1 > maxX) maxX = x1;
            if (y1 > maxY) maxY = y1;
          }
        }
      }
    }

    const text = words.join(" ").trim();
    if (!text || !isTranslatable(text) || looksLikeOcrGarbage(text)) return null;

    return {
      id,
      text,
      box: {
        left: minX * toDisplayScale + offset.left,
        top: minY * toDisplayScale + offset.top,
        width: (maxX - minX) * toDisplayScale,
        height: (maxY - minY) * toDisplayScale,
        angle: 0,
      },
      translatable: true,
      pageIndex,
    };
  });
}
