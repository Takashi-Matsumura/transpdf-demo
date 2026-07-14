// テキスト層を持たない（スキャン/画像ベースの）PDFのためのOCRフォールバック。
// tesseract.js は必ずブラウザ側の呼び出しからのみ使う（動的import + useEffect経由）。
import type { Worker } from "tesseract.js";
import { buildLineGroups, isTranslatable } from "./pdf";
import type { RawItem } from "./pdf";
import type { LineGroup } from "./types";

let workerPromise: Promise<Worker> | null = null;

/**
 * OCR結果が文字として読み取れていない（記号・数字が大半を占める）行を検出する。
 * こうした断片をLLMに投げると、モデルが解釈できず出力が長時間化・暴走しやすいため、
 * 事前に弾いて翻訳をスキップする。
 */
function looksLikeOcrGarbage(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length === 0) return true;
  const letterCount = (stripped.match(/\p{L}/gu) ?? []).length;
  return letterCount / stripped.length < 0.5;
}

/**
 * ベトナム語+日本語OCR用のワーカーを一度だけ生成し、以降は再利用する。
 * 対訳PDF（原文の隣に既存の日本語訳が印字されている）では、日本語部分も
 * 正しく認識できないとレイアウト解析やbboxが乱れるため、両言語を読み込む。
 */
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = import("tesseract.js").then(({ createWorker }) =>
      createWorker(["vie", "jpn"], 1, {
        // ブラウザ既定はCDN参照のため、public/ に同期した実ファイルを明示する。
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract-core",
      })
    );
  }
  return workerPromise;
}

/**
 * canvas（OCR用に高解像度でレンダリングしたもの）をOCRし、セル単位のLineGroupを返す。
 * bbox は canvas のピクセル座標なので、表示用ビューポートとの縮尺差を toDisplayScale で補正する。
 *
 * Tesseractの行（line）単位のテキストをそのまま1つの翻訳対象にすると、
 * 表の複数列（例:「口座番号」「支店」「金額」）が1つの文字列に結合されてしまい、
 * 翻訳結果が読みにくくなる。そこで単語（word）単位のbboxまで分解し、
 * pdfjsのテキスト層と同じ「行内の水平ギャップでセル分割する」ロジックに通す。
 */
export async function runOcr(
  canvas: HTMLCanvasElement,
  toDisplayScale: number
): Promise<LineGroup[]> {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true });

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

  const groups = buildLineGroups(raw, { joiner: " " });
  return groups.map((g) => ({
    ...g,
    id: `ocr-${g.id}`,
    translatable: g.translatable && !looksLikeOcrGarbage(g.text),
  }));
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
 */
export async function runOcrRegion(
  canvas: HTMLCanvasElement,
  toDisplayScale: number,
  offset: { left: number; top: number },
  id: string
): Promise<LineGroup | null> {
  const worker = await getWorker();
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
  };
}
