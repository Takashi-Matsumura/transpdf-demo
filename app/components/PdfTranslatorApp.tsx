"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import PdfOverlayViewer from "./PdfOverlayViewer";
import { analyzeDocument, translateGroups } from "@/app/lib/translate-client";
import type { DocumentAnalysis, LineGroup, TranslationEntry } from "@/app/lib/types";

const EXPERT_LABELS: Record<DocumentAnalysis["expert"], string> = {
  finance: "金融・会計",
  legal: "法務・契約",
  medical: "医療・薬事",
  technical: "技術・製造",
  general: "一般文書",
};

export default function PdfTranslatorApp() {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationEntry>>({});
  const [showTranslation, setShowTranslation] = useState(true);
  const [status, setStatus] = useState<"idle" | "translating" | "done" | "error">(
    "idle"
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selectionMode, setSelectionMode] = useState(false);
  const [manualGroups, setManualGroups] = useState<LineGroup[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  // 「翻訳結果を削除」で非表示にした自動抽出グループのid集合。
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  // パス1（単語単位の独立翻訳）で抽出された自動グループ。パス2の文脈適応翻訳で
  // 全体を対象に再翻訳する際に必要なため、Viewerからの通知を親側にも保持しておく。
  const [extractedGroups, setExtractedGroups] = useState<LineGroup[]>([]);
  // パス2: 文書全体の文脈推定→文脈を踏まえた全体再翻訳。
  const [documentAnalysis, setDocumentAnalysis] = useState<DocumentAnalysis | null>(null);
  const [refineStatus, setRefineStatus] = useState<
    "idle" | "analyzing" | "refining" | "done" | "error"
  >("idle");
  const [refineError, setRefineError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);
  // 手動領域の翻訳は初回翻訳と独立して走らせるため、専用のコントローラで中断管理する。
  const manualAbortRef = useRef<AbortController | null>(null);
  // パス2（文脈適応の全体再翻訳）専用のコントローラ。
  const refineAbortRef = useRef<AbortController | null>(null);
  const failedCount = Object.values(translations).filter((t) => t.failed).length;

  const loadFile = useCallback(async (buffer: ArrayBuffer, name: string) => {
    abortRef.current?.abort();
    manualAbortRef.current?.abort();
    refineAbortRef.current?.abort();
    setData(buffer);
    setFileName(name);
    setTranslations({});
    setManualGroups([]);
    setDismissedIds(new Set());
    setExtractedGroups([]);
    setDocumentAnalysis(null);
    setRefineStatus("idle");
    setRefineError(null);
    setSelectionMode(false);
    setStatus("idle");
    setErrorMessage(null);
    setZoom(1);
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100));
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100));
  }, []);
  const zoomReset = useCallback(() => setZoom(1), []);

  const loadPdfFile = useCallback(
    async (file: File) => {
      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setDropError("PDFファイルを選択してください");
        return;
      }
      setDropError(null);
      const buffer = await file.arrayBuffer();
      await loadFile(buffer, file.name);
    },
    [loadFile]
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await loadPdfFile(file);
      // 同じファイルを続けて選び直せるよう入力値をリセットする
      e.target.value = "";
    },
    [loadPdfFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // 子要素間のenter/leaveで誤ってfalseにしないよう、コンテナ外に出たときだけ解除する
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      await loadPdfFile(file);
    },
    [loadPdfFile]
  );

  const handleExtracted = useCallback((groups: LineGroup[]) => {
    setExtractedGroups(groups);
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("translating");
    setErrorMessage(null);

    translateGroups(
      groups,
      (partial) => {
        startTransition(() => {
          setTranslations((prev) => ({ ...prev, ...partial }));
        });
      },
      controller.signal
    )
      .then(() => {
        if (!controller.signal.aborted) setStatus("done");
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setStatus("error");
          setErrorMessage(e instanceof Error ? e.message : String(e));
        }
      });
  }, []);

  const handleManualRegion = useCallback((group: LineGroup) => {
    setManualGroups((prev) => [...prev, group]);
    // 初回翻訳のコントローラを奪わないよう、手動領域は専用コントローラで翻訳する。
    const controller = new AbortController();
    manualAbortRef.current = controller;
    translateGroups(
      [group],
      (partial) => {
        startTransition(() => {
          setTranslations((prev) => ({ ...prev, ...partial }));
        });
      },
      controller.signal
    ).catch((e) => {
      // 手動領域の翻訳失敗は致命的ではないので、原文フォールバックのまま留める。
      if (!controller.signal.aborted) {
        console.error("手動領域の翻訳に失敗しました:", e);
      }
    });
  }, []);

  const clearManualRegions = useCallback(() => {
    manualAbortRef.current?.abort();
    setManualGroups([]);
    // 手動グループぶんの翻訳結果（manual- 始まりのid）だけを取り除く。
    setTranslations((prev) => {
      const next: Record<string, TranslationEntry> = {};
      for (const [id, entry] of Object.entries(prev)) {
        if (!id.startsWith("manual-")) next[id] = entry;
      }
      return next;
    });
  }, []);

  const handleRetranslate = useCallback((group: LineGroup) => {
    // いったん翻訳結果を消して「翻訳待ち」表示に戻し、同じテキストをLLMへ送り直す。
    setTranslations((prev) => {
      const next = { ...prev };
      delete next[group.id];
      return next;
    });
    const controller = new AbortController();
    manualAbortRef.current = controller;
    translateGroups(
      [group],
      (partial) => {
        startTransition(() => {
          setTranslations((prev) => ({ ...prev, ...partial }));
        });
      },
      controller.signal
    ).catch((e) => {
      if (!controller.signal.aborted) {
        console.error("再翻訳に失敗しました:", e);
      }
    });
  }, []);

  const handleRefineWithContext = useCallback(() => {
    refineAbortRef.current?.abort();
    const controller = new AbortController();
    refineAbortRef.current = controller;

    // 削除された自動グループを除き、手動グループを加えた「現在表示中」の対象を集める。
    const targets = [
      ...extractedGroups.filter((g) => !dismissedIds.has(g.id)),
      ...manualGroups,
    ].filter((g) => g.translatable);

    if (targets.length === 0) return;

    setRefineStatus("analyzing");
    setRefineError(null);

    // 文脈推定には原文と現時点の訳文のペアを渡す。誤訳が混じっていても、
    // 原文も一緒に見せることで文書全体の分野を推定しやすくする狙い。
    const lines = targets.map((g) => {
      const t = translations[g.id];
      return t ? `${g.text} → ${t.text}` : g.text;
    });

    analyzeDocument(lines, controller.signal)
      .then((analysis) => {
        if (controller.signal.aborted) return;
        if (!analysis) {
          setRefineStatus("error");
          setRefineError("文書の文脈を推定できませんでした（ローカルLLMの応答が不正でした）");
          return;
        }
        setDocumentAnalysis(analysis);
        setRefineStatus("refining");

        return translateGroups(
          targets,
          (partial) => {
            startTransition(() => {
              setTranslations((prev) => ({ ...prev, ...partial }));
            });
          },
          controller.signal,
          { context: analysis.summary, expert: analysis.expert }
        ).then(() => {
          if (!controller.signal.aborted) setRefineStatus("done");
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setRefineStatus("error");
          setRefineError(e instanceof Error ? e.message : String(e));
        }
      });
  }, [extractedGroups, manualGroups, dismissedIds, translations]);

  const handleDismiss = useCallback((id: string) => {
    // 翻訳結果を消し、ボックス自体も非表示にする。
    // この後ユーザーが「OCRエリア指定」で同じ場所を囲み直せば、新しい手動グループとして再翻訳できる。
    setTranslations((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (id.startsWith("manual-")) {
      // 手動グループは配列から取り除けば非表示になる。
      setManualGroups((prev) => prev.filter((g) => g.id !== id));
    } else {
      // 自動抽出グループはViewer内部のstateなので直接消せない。非表示idとして記録する。
      setDismissedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          外国語PDF 日本語オーバーレイ翻訳
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          ベトナム語などのPDFを読み込むと、常駐中のローカルLLM（llama.cpp /
          gemma-4-12b）が日本語に翻訳し、元のレイアウトの上に重ねて表示します。
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]">
            PDFをアップロード
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleFileInput}
            />
          </label>

          {data && (
            <label className="ml-auto flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showTranslation}
                onChange={(e) => setShowTranslation(e.target.checked)}
              />
              日本語訳を表示
            </label>
          )}
        </div>

        {fileName && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            読み込み中: {fileName}
            {status === "translating" && " ・翻訳中…"}
            {status === "done" && failedCount === 0 && " ・翻訳完了"}
            {status === "done" &&
              failedCount > 0 &&
              ` ・翻訳完了（${failedCount}件はローカルLLMの応答が得られず原文のままです。オレンジ色の枠が対象です）`}
            {status === "error" && ` ・翻訳エラー: ${errorMessage}`}
          </p>
        )}

        {data && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">表示倍率:</span>
            <button
              type="button"
              onClick={zoomOut}
              disabled={zoom <= 0.5}
              aria-label="縮小"
              className="flex h-7 w-7 items-center justify-center rounded border border-black/[.15] leading-none hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
            >
              −
            </button>
            <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={zoomIn}
              disabled={zoom >= 3}
              aria-label="拡大"
              className="flex h-7 w-7 items-center justify-center rounded border border-black/[.15] leading-none hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
            >
              ＋
            </button>
            <button
              type="button"
              onClick={zoomReset}
              className="rounded border border-black/[.15] px-2 py-1 text-xs hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
            >
              リセット
            </button>
          </div>
        )}

        {data && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setSelectionMode((v) => !v)}
              aria-pressed={selectionMode}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                selectionMode
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "border border-black/[.15] hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
              }`}
            >
              {selectionMode ? "OCRエリア指定中（クリックで終了）" : "OCRエリア指定"}
            </button>
            {selectionMode && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                翻訳したい部分をドラッグで囲んでください
              </span>
            )}
            {manualGroups.length > 0 && (
              <button
                type="button"
                onClick={clearManualRegions}
                className="rounded border border-black/[.15] px-2 py-1 text-xs hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
              >
                手動選択をクリア（{manualGroups.length}）
              </button>
            )}
          </div>
        )}

        {data && (status === "done" || refineStatus !== "idle") && (
          <div className="flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleRefineWithContext}
                disabled={refineStatus === "analyzing" || refineStatus === "refining"}
                className="rounded-full bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {refineStatus === "analyzing"
                  ? "文書の文脈を推定中…"
                  : refineStatus === "refining"
                    ? "文脈を踏まえて再翻訳中…"
                    : "文脈を踏まえて全体を再翻訳"}
              </button>
              <span className="text-xs text-blue-800 dark:text-blue-300">
                単語ごとの独立翻訳を、文書全体の文脈を踏まえて見直します
              </span>
            </div>
            {documentAnalysis && (
              <p className="text-xs text-blue-900 dark:text-blue-200">
                推定された文書: 「{documentAnalysis.summary}」（分野:{" "}
                {EXPERT_LABELS[documentAnalysis.expert]}）
              </p>
            )}
            {refineStatus === "error" && refineError && (
              <p className="text-xs text-red-600">{refineError}</p>
            )}
          </div>
        )}

        {data && (
          <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 border-[1.5px] border-solid border-[#2563eb] bg-[#dbeafe]" />
              ローカルLLMの翻訳
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 border-[1.5px] border-dashed border-[#ca8a04] bg-[#fef9c3]" />
              翻訳待ち
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 border-[1.5px] border-dashed border-[#ea580c] bg-[#fed7aa]" />
              翻訳失敗（原文のまま）
            </span>
            <span>翻訳済みのボックスにマウスを乗せると再翻訳・削除ができます</span>
          </div>
        )}
      </div>

      <div className="flex w-full justify-center overflow-auto">
        {data ? (
          <PdfOverlayViewer
            data={data}
            translations={translations}
            showTranslation={showTranslation}
            zoom={zoom}
            onExtracted={handleExtracted}
            selectionMode={selectionMode}
            manualGroups={manualGroups}
            onManualRegion={handleManualRegion}
            dismissedIds={dismissedIds}
            onRetranslate={handleRetranslate}
            onDismiss={handleDismiss}
          />
        ) : (
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`flex h-64 w-full max-w-3xl flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-sm transition-colors ${
              isDragging
                ? "border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-950/30 dark:text-blue-300"
                : "border-black/[.15] text-zinc-500 dark:border-white/[.15] dark:text-zinc-400"
            }`}
          >
            <span>
              {isDragging
                ? "ここにドロップして読み込み"
                : "PDFをここにドラッグ＆ドロップ"}
            </span>
            <span className="text-xs">
              または上の「PDFをアップロード」ボタンから選択
            </span>
            {dropError && <span className="text-xs text-red-600">{dropError}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
