// pdfjs-dist のロードとテキスト抽出・座標変換のユーティリティ。
// このモジュールは必ずブラウザ（クライアント）側の useEffect 内から呼ぶこと。
// トップレベルで pdfjs-dist を import すると SSR 時に評価されクラッシュしうるため、
// ロードは動的 import (loadPdfjs) 経由に限定する。
import type * as PdfjsNS from "pdfjs-dist";
import type { PageViewport, PDFPageProxy } from "pdfjs-dist";
import type { Box, LineGroup, SourceLang } from "./types";

// pdfjs-dist は TextItem を型エクスポートしていないため、
// getTextContent() の戻り値から items の要素型を導出する。
type TextContentItems = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"];

let pdfjsPromise: Promise<typeof PdfjsNS> | null = null;

/** pdfjs-dist を動的 import し、worker/フォント資産を設定して返す（一度だけ実行）。 */
export function loadPdfjs(): Promise<typeof PdfjsNS> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      // public/ にコピーした実ファイルを指す。CDNやバンドラのURL解決に頼らず、
      // インストール済み pdfjs-dist と確実にバージョンが一致する。
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const JAPANESE_SCRIPT_RE = /[぀-ヿ一-鿿]/gu;

/**
 * ひらがな・カタカナ・漢字が大半を占めるテキストかどうか。
 * 対訳PDFなど、原文の隣に既に日本語訳が印字されているケースでこれを検出し、
 * 二重翻訳（既に日本語のものをさらに翻訳しようとする）を避けるために使う。
 */
function isMostlyJapanese(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length === 0) return false;
  const jaCount = (stripped.match(JAPANESE_SCRIPT_RE) ?? []).length;
  return jaCount / stripped.length > 0.3;
}

// ミャンマー文字（基本ブロックのみ。拡張ブロックは実文書でほぼ使われない）。
const MYANMAR_SCRIPT_RE = /[က-႟]/gu;
// ベトナム語にしか現れないラテン文字（ă đ ơ ư と声調記号付きの U+1EA0–U+1EF9 ブロック）。
// â ê ô à é などは他言語ともLatin-1で共有するため、あえて含めない。
const VIETNAMESE_SCRIPT_RE = /[Ạ-ỹĂăĐđƠơƯư]/gu;

const LANG_DETECT_MIN_CHARS = 20; // これ未満は判定材料不足として扱う
const MYANMAR_RATIO_THRESHOLD = 0.1; // 英語併記の公文書でもミャンマー文字は1割は占める
const VIETNAMESE_MIN_HITS = 3; // OCRノイズ1〜2文字での誤判定を防ぐ下限

/**
 * 抽出済みテキスト（複数グループぶんを連結したもの）から原文の言語を推定する。
 * isMostlyJapanese と同じ「Unicodeスクリプトの出現比率で判定する」方式。
 * 判定材料が乏しい場合は null を返し、呼び出し側は「未確定」として扱う
 * （中立なプロンプトを使う／手動選択を促す）。
 */
export function detectSourceLang(text: string): SourceLang | null {
  const stripped = text.replace(/\s/g, "");
  if (stripped.length < LANG_DETECT_MIN_CHARS) return null;
  const myanmarRatio =
    (stripped.match(MYANMAR_SCRIPT_RE) ?? []).length / stripped.length;
  if (myanmarRatio > MYANMAR_RATIO_THRESHOLD) return "mya";
  const vietnameseHits = (stripped.match(VIETNAMESE_SCRIPT_RE) ?? []).length;
  if (vietnameseHits >= VIETNAMESE_MIN_HITS) return "vie";
  return /[A-Za-z]{2,}/.test(stripped) ? "eng" : null;
}

/** 数字・記号・空白のみ、または既に日本語のテキストは翻訳対象外とする。 */
export function isTranslatable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isMostlyJapanese(trimmed)) return false;
  // 英数字・記号・空白だけなら翻訳不要（口座番号、金額、日付など）
  // 越語はラテン文字＋声調記号を使うため、ASCII以外の文字を含む場合は翻訳対象とする。
  const hasNonAscii = /[^\x00-\x7F]/.test(trimmed);
  if (hasNonAscii) return true;
  // ASCIIのみの場合、アルファベットを含めば（英単語の可能性）翻訳対象とする。
  return /[A-Za-z]{2,}/.test(trimmed);
}

export type RawItem = {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  fontHeight: number;
  angle: number;
};

/**
 * page.getTextContent() の各アイテムを viewport 座標（CSS px, 左上原点）へ変換する。
 * viewport.transform ∘ item.transform を合成し、フォント高・原点を導出する。
 * （pdfjs 公式の text_layer 実装と同じロジック）
 */
function toRawItems(
  pdfjs: typeof PdfjsNS,
  items: TextContentItems,
  viewport: PageViewport
): RawItem[] {
  const raw: RawItem[] = [];
  for (const item of items) {
    if (!("str" in item) || item.str.trim().length === 0) continue;
    const tx = pdfjs.Util.transform(
      viewport.transform,
      item.transform
    ) as number[];

    const fontHeight = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const originX = tx[4];
    const originY = tx[5];
    // item.width は回転前のPDFユーザー空間での前進幅なので、viewportの拡大率のみを掛ける。
    // tx[0]/tx[1] にはフォント自体のスケール（文字サイズ）も含まれており、それを掛けると
    // 幅が二重にスケールされて実際より大きくなってしまう（pdf.js公式のtext_layerと同じ計算式）。
    const widthPx = item.width * viewport.scale;

    raw.push({
      text: item.str,
      left: originX,
      top: originY - fontHeight,
      right: originX + widthPx,
      bottom: originY,
      fontHeight,
      angle,
    });
  }
  return raw;
}

export function groupTextItems(
  pdfjs: typeof PdfjsNS,
  items: TextContentItems,
  viewport: PageViewport
): LineGroup[] {
  return buildLineGroups(toRawItems(pdfjs, items, viewport));
}

/**
 * 位置情報付きテキスト断片（pdfjsのテキストアイテム、OCRの単語など）を
 * 行単位（ベースラインが近いアイテム）にバケット化し、各行内で水平ギャップが
 * 大きい箇所をセル境界とみなして分割する。表形式の明細で列同士の翻訳が
 * 混ざらないようにするための処理。抽出元（pdfjs/OCR）に依存しない汎用ロジック。
 */
export function buildLineGroups(
  raw: RawItem[],
  options?: { joiner?: string }
): LineGroup[] {
  const joiner = options?.joiner ?? "";
  if (raw.length === 0) return [];

  // ベースライン（bottom）でソートし、近いものを同じ行としてまとめる
  const sorted = [...raw].sort((a, b) => a.bottom - b.bottom || a.left - b.left);

  const lines: RawItem[][] = [];
  for (const item of sorted) {
    const lastLine = lines[lines.length - 1];
    const lastItem = lastLine?.[lastLine.length - 1];
    const threshold = item.fontHeight * 0.5;
    if (lastItem && Math.abs(item.bottom - lastItem.bottom) <= threshold) {
      lastLine.push(item);
    } else {
      lines.push([item]);
    }
  }

  const groups: LineGroup[] = [];
  let groupIndex = 0;

  for (const line of lines) {
    const byLeft = [...line].sort((a, b) => a.left - b.left);
    let cell: RawItem[] = [byLeft[0]];

    const flushCell = () => {
      if (cell.length === 0) return;
      const left = Math.min(...cell.map((c) => c.left));
      const top = Math.min(...cell.map((c) => c.top));
      const right = Math.max(...cell.map((c) => c.right));
      const bottom = Math.max(...cell.map((c) => c.bottom));
      const text = cell.map((c) => c.text).join(joiner);
      const box: Box = {
        left,
        top,
        width: right - left,
        height: bottom - top,
        angle: cell[0].angle,
      };
      groups.push({
        id: `g${groupIndex++}`,
        text,
        box,
        translatable: isTranslatable(text),
      });
      cell = [];
    };

    for (let i = 1; i < byLeft.length; i++) {
      const prev = byLeft[i - 1];
      const curr = byLeft[i];
      const gap = curr.left - prev.right;
      // ギャップがフォント高の1.5倍以上なら別セル（表の列区切り）とみなす
      if (gap > prev.fontHeight * 1.5) {
        flushCell();
      }
      cell.push(curr);
    }
    flushCell();
  }

  return groups;
}
