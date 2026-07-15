import type {
  DocumentAnalysis,
  ExpertKey,
  LineGroup,
  TranslationEntry,
} from "./types";

/** パス2（文脈適応翻訳）で各翻訳リクエストに添える文脈とエキスパート。 */
type TranslateOptions = { context?: string; expert?: ExpertKey };

// サーバー側は1行ずつ独立して翻訳・リトライするため、クライアントは
// 進捗をこまめに反映できるよう小さめのチャンクで送る。
const MAX_ITEMS_PER_CHUNK = 5;
const MAX_CHARS_PER_CHUNK = 300;

function chunkGroups(groups: LineGroup[]): LineGroup[][] {
  const chunks: LineGroup[][] = [];
  let current: LineGroup[] = [];
  let currentChars = 0;

  for (const g of groups) {
    const wouldExceed =
      current.length >= MAX_ITEMS_PER_CHUNK ||
      (current.length > 0 && currentChars + g.text.length > MAX_CHARS_PER_CHUNK);
    if (wouldExceed) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(g);
    currentChars += g.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 翻訳対象グループを順にAPIへ送り、id -> 翻訳結果 のマップを都度 onProgress で通知する。
 * 同一文字列はメモ化して再送しない（明細票は同じラベルが繰り返されやすいため）。
 * 個々の行の成否はサーバー側の failed 配列でそのまま判定する
 * （リトライもサーバー側で行済みのため、ここでは再送しない）。
 */
export async function translateGroups(
  groups: LineGroup[],
  onProgress: (partial: Record<string, TranslationEntry>) => void,
  signal?: AbortSignal,
  options?: TranslateOptions
): Promise<void> {
  const targets = groups.filter((g) => g.translatable);
  if (targets.length === 0) return;

  const cache = new Map<string, TranslationEntry>();
  const chunks = chunkGroups(targets);

  for (const chunk of chunks) {
    if (signal?.aborted) return;

    const uncached = chunk.filter((g) => !cache.has(g.text));
    if (uncached.length > 0) {
      try {
        const res = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            texts: uncached.map((g) => g.text),
            context: options?.context,
            expert: options?.expert,
          }),
          signal,
        });
        const json = (await res.json()) as { translations: string[]; failed: boolean[] };
        uncached.forEach((g, i) => {
          cache.set(g.text, {
            text: json.translations[i] ?? g.text,
            failed: json.failed[i] ?? true,
          });
        });
      } catch {
        // fetch自体の失敗（接続不可など）。この行は原文フォールバック扱いにする。
        uncached.forEach((g) => {
          cache.set(g.text, { text: g.text, failed: true });
        });
      }
    }

    const partial: Record<string, TranslationEntry> = {};
    for (const g of chunk) {
      partial[g.id] = cache.get(g.text) ?? { text: g.text, failed: true };
    }
    onProgress(partial);
  }
}

/**
 * パス1（単語単位の独立翻訳）の結果を俯瞰させ、この文書が何についての
 * 資料かをローカルLLMに推定させる（パス2「文脈適応翻訳」の前段）。
 * 失敗時はnullを返し、呼び出し側はパス1の結果をそのまま使い続けられる。
 */
export async function analyzeDocument(
  lines: string[],
  signal?: AbortSignal
): Promise<DocumentAnalysis | null> {
  if (lines.length === 0) return null;
  try {
    const res = await fetch("/api/analyze-document", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines }),
      signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (typeof json?.summary !== "string" || typeof json?.expert !== "string") return null;
    return json as DocumentAnalysis;
  } catch {
    return null;
  }
}
