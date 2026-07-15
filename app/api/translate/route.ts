// このPCに常駐している llama.cpp サーバ（OpenAI互換 API, gemma-4-12b）へ
// ベトナム語→日本語の翻訳をリクエストする Route Handler。
// localhost へ到達する必要があるため Edge ではなく Node ランタイムで実行する。
//
// このモデルは既定でチェイン・オブ・ソート（推論チャンネル）を出力するチャット
// テンプレートを持ち、2語程度の翻訳でも100トークン超の「思考」を生成してから
// 本文を返すため非常に遅い（実測: 8.7秒/119トークン）。
// chat_template_kwargs.enable_thinking=false でこれを無効化すると
// 同じ翻訳が67ミリ秒/2トークンで完了することを確認済み。
// （reasoning_effort パラメータはこのテンプレートには効かない）
//
// 1リクエストにまとめてJSON配列で翻訳させる方式は、上記の推論フェーズと
// 組み合わさると生成が長時間化・タイムアウトしやすかったため採用していない。
// 1行ずつの単純な平文翻訳に分割し、各行を独立してリトライ・成否判定する。
export const runtime = "nodejs";

import type { ExpertKey } from "@/app/lib/types";

// MoE（Mixture of Experts）モデルを使う場合、この環境変数でモデル名を切り替えられる。
// dense/MoE いずれの場合も、下記の分野ヒント（buildPrompt の expertLabel）は
// プロンプト先頭の文脈として作用し、翻訳精度の底上げに寄与する。
// ただし、どの専門家ネットワークが実際に活性化されるかはモデル内部のルーティング
// 次第であり、アプリ側から専門家を直接指定するAPIは存在しない — できるのは
// 「その分野向けの翻訳である」という手がかりをプロンプトに与えることだけである。
const LLAMA_MODEL = process.env.LLAMA_MODEL ?? "gemma-4-12b-it-Q4_K_M.gguf";
// 思考フェーズを無効化しているため通常は数百ms〜数秒で返る。
// これを超える場合はモデル/サーバ側で異常が起きていると判断して打ち切る。
const PER_ITEM_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;

const EXPERT_LABELS: Record<ExpertKey, string> = {
  finance: "金融・会計（銀行明細、請求書、財務諸表など）",
  legal: "法務・契約（契約書、規約、証明書など）",
  medical: "医療・薬事（診断書、処方箋、医薬品表示など）",
  technical: "技術・製造（仕様書、マニュアル、規格文書など）",
  general: "一般文書",
};

function buildPrompt(text: string, context?: string, expert?: ExpertKey): string {
  // パス2（文脈適応翻訳）では、文書全体の要約と分野ヒントをプロンプト先頭に付与する。
  // 「単語ごとに独立翻訳」で欠けていた文書全体の文脈をここで補う。
  const contextBlock =
    context || expert
      ? `この文書は「${context ?? "詳細不明"}」に関する資料です（分野: ${
          expert ? EXPERT_LABELS[expert] : "不明"
        }）。この文脈を踏まえて翻訳してください。\n\n`
      : "";

  return `${contextBlock}次のベトナム語のテキストを自然で簡潔な日本語に翻訳してください。
訳文だけを1行で出力してください（説明・前置き・引用符・原文の繰り返しは不要です）。
数字・日付・口座番号・記号はできるだけそのまま残してください。
意味の無い文字列や翻訳できない場合は、そのまま出力してください。

ベトナム語: ${text}
日本語:`;
}

function estimateMaxTokens(text: string): number {
  return Math.min(300, Math.max(80, text.length * 3));
}

function cleanTranslation(raw: string): string {
  return raw
    .trim()
    .split("\n")[0]
    .trim()
    .replace(/^["「『]+|["」』]+$/g, "")
    .trim();
}

async function translateOne(
  base: string,
  text: string,
  outerSignal: AbortSignal,
  context?: string,
  expert?: ExpertKey
): Promise<{ text: string; failed: boolean }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (outerSignal.aborted) return { text, failed: true };

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    outerSignal.addEventListener("abort", onOuterAbort);
    const timeout = setTimeout(() => controller.abort(), PER_ITEM_TIMEOUT_MS);

    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: LLAMA_MODEL,
          messages: [{ role: "user", content: buildPrompt(text, context, expert) }],
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: estimateMaxTokens(text),
          stream: false,
          // このチャットテンプレートの推論（思考）フェーズを無効化する。
          // 無効化しないと数語の翻訳でも数秒〜長時間かかる。
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });

      if (!res.ok) continue;

      const data = await res.json();
      const raw: string = data?.choices?.[0]?.message?.content ?? "";
      const cleaned = cleanTranslation(raw);
      if (cleaned) return { text: cleaned, failed: false };
    } catch {
      // タイムアウト・接続エラー。リトライへ。
    } finally {
      clearTimeout(timeout);
      outerSignal.removeEventListener("abort", onOuterAbort);
    }
  }
  return { text, failed: true };
}

export async function POST(request: Request) {
  let texts: unknown;
  let context: unknown;
  let expert: unknown;
  try {
    const body = await request.json();
    texts = body?.texts;
    context = body?.context;
    expert = body?.expert;
  } catch {
    return Response.json({ translations: [], failed: [] }, { status: 400 });
  }

  if (!Array.isArray(texts) || texts.length === 0) {
    return Response.json({ translations: [], failed: [] });
  }
  const textList = texts.map((t) => String(t));
  const contextStr = typeof context === "string" && context.trim() ? context : undefined;
  const expertKey: ExpertKey | undefined =
    typeof expert === "string" &&
    (["finance", "legal", "medical", "technical", "general"] as const).includes(
      expert as ExpertKey
    )
      ? (expert as ExpertKey)
      : undefined;
  const base = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080";

  const controller = new AbortController();
  request.signal.addEventListener("abort", () => controller.abort());

  const translations: string[] = [];
  const failed: boolean[] = [];
  // llama.cppはローカル単一インスタンスのため並列化のメリットが薄く、
  // 直列に処理して各行のタイムアウト・リトライを独立に扱う。
  for (const text of textList) {
    const result = await translateOne(base, text, controller.signal, contextStr, expertKey);
    translations.push(result.text);
    failed.push(result.failed);
  }

  return Response.json({ translations, failed });
}
