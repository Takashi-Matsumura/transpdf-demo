// パス1（単語/セル単位の独立翻訳）が完了したあと、その訳文を俯瞰して
// 「この文書は何についての資料か」をローカルLLMに推定させる Route Handler。
// 推定結果（DocumentAnalysis）はパス2の文脈適応翻訳（/api/translate の context/expert）
// に渡され、各行の再翻訳プロンプトに埋め込まれる。
//
// localhost へ到達する必要があるため Edge ではなく Node ランタイムで実行する。
export const runtime = "nodejs";

import type { DocumentAnalysis, ExpertKey } from "@/app/lib/types";

const LLAMA_MODEL = process.env.LLAMA_MODEL ?? "gemma-4-12b-it-Q4_K_M.gguf";
const TIMEOUT_MS = 30_000;
// 文書全体を俯瞰させるが、プロンプトが際限なく膨らまないよう代表的な行数に絞る。
const MAX_SAMPLE_LINES = 60;
const MAX_CHARS_PER_LINE = 40;

const EXPERT_KEYS: ExpertKey[] = ["finance", "legal", "medical", "technical", "general"];

function buildPrompt(lines: string[]): string {
  const sample = lines
    .slice(0, MAX_SAMPLE_LINES)
    .map((l) => l.slice(0, MAX_CHARS_PER_LINE))
    .join("\n");

  return `以下は、あるベトナム語PDF文書から抽出した断片的な単語・訳文の一覧です（原文と暫定的な日本語訳が混在しています）。
これらの断片から、この文書が全体として何についての資料か（分野・種類・目的）を推定してください。

出力は次のJSON形式のみで、説明文やコードブロックの記号は付けないでください。
{"summary": "1〜2文の日本語の要約", "expert": "finance" | "legal" | "medical" | "technical" | "general" のいずれか1つ}

- summary: 例「ベトナムの銀行が発行した法人向け口座取引明細書」のように、文書の種類と分野を具体的に。
- expert: 文書の分野に最も近いものを1つだけ選んでください。該当がなければ "general"。

断片一覧:
${sample}

JSON:`;
}

function parseAnalysis(raw: string): DocumentAnalysis | null {
  // モデルがコードブロックや前置きを付けてしまう場合に備え、最初の { ... } を抜き出す。
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const expertRaw = typeof parsed.expert === "string" ? parsed.expert.trim() : "general";
    const expert = EXPERT_KEYS.includes(expertRaw as ExpertKey)
      ? (expertRaw as ExpertKey)
      : "general";
    if (!summary) return null;
    return { summary, expert };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  let lines: unknown;
  try {
    const body = await request.json();
    lines = body?.lines;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return Response.json({ error: "empty_lines" }, { status: 400 });
  }

  const textLines = lines.map((l) => String(l));
  const base = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080";

  const controller = new AbortController();
  request.signal.addEventListener("abort", () => controller.abort());
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLAMA_MODEL,
        messages: [{ role: "user", content: buildPrompt(textLines) }],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 300,
        stream: false,
        // 翻訳と同じ理由で、思考フェーズは無効化する（有効だと大幅に遅くなるモデルがある）。
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return Response.json({ error: "llm_error" }, { status: 502 });
    }

    const data = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content ?? "";
    const analysis = parseAnalysis(raw);
    if (!analysis) {
      return Response.json({ error: "unparseable_response" }, { status: 502 });
    }

    return Response.json(analysis satisfies DocumentAnalysis);
  } catch {
    return Response.json({ error: "request_failed" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
