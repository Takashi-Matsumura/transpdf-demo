import type { LineGroup, TranslationEntry } from "./types";

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
  signal?: AbortSignal
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
          body: JSON.stringify({ texts: uncached.map((g) => g.text) }),
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
