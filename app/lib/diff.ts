// 文脈適応翻訳（パス2）で更新された訳文のうち、実際に変わった文字だけを
// ハイライトするための、文字単位の簡易diffユーティリティ。
// 日本語は単語区切りがないため、形態素解析には頼らず文字（コードポイント）単位で比較する。

export type DiffSegment = { text: string; changed: boolean };

/**
 * oldStr → newStr への変化を、newStr側の文字列として
 * 「変わっていない区間」「変わった区間」に分割して返す。
 * LCS（最長共通部分列）に基づく標準的なdiffアルゴリズム。
 * 文字列は数十文字程度（1翻訳ボックスぶん）を想定しており、O(m*n)で十分高速。
 */
export function diffChars(oldStr: string, newStr: string): DiffSegment[] {
  const oldChars = Array.from(oldStr);
  const newChars = Array.from(newStr);
  const m = oldChars.length;
  const n = newChars.length;

  if (m === 0 || n === 0) {
    return newChars.length > 0 ? [{ text: newStr, changed: true }] : [];
  }

  // dp[i][j] = oldChars[0..i) と newChars[0..j) の最長共通部分列(LCS)の長さ
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldChars[i - 1] === newChars[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // バックトラックして、newChars の各位置がLCS（＝変更なし）に含まれるかを判定する。
  const unchanged = new Array(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldChars[i - 1] === newChars[j - 1]) {
      unchanged[j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // 連続する同種（変更あり/なし）の文字をまとめてセグメント化する。
  const segments: DiffSegment[] = [];
  let current = "";
  let currentChanged = false;
  for (let k = 0; k < n; k++) {
    const changed = !unchanged[k];
    if (current !== "" && changed !== currentChanged) {
      segments.push({ text: current, changed: currentChanged });
      current = "";
    }
    current += newChars[k];
    currentChanged = changed;
  }
  if (current !== "") segments.push({ text: current, changed: currentChanged });

  return segments;
}
