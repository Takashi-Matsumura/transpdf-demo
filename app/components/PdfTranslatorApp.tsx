"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import PdfOverlayViewer from "./PdfOverlayViewer";
import { translateGroups } from "@/app/lib/translate-client";
import type { LineGroup, TranslationEntry } from "@/app/lib/types";

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
  const [, startTransition] = useTransition();
  const abortRef = useRef<AbortController | null>(null);
  const failedCount = Object.values(translations).filter((t) => t.failed).length;

  const loadFile = useCallback(async (buffer: ArrayBuffer, name: string) => {
    abortRef.current?.abort();
    setData(buffer);
    setFileName(name);
    setTranslations({});
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

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      await loadFile(buffer, file.name);
    },
    [loadFile]
  );

  const handleExtracted = useCallback((groups: LineGroup[]) => {
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
          />
        ) : (
          <div className="flex h-64 w-full max-w-3xl items-center justify-center rounded-lg border border-dashed border-black/[.15] text-sm text-zinc-500 dark:border-white/[.15] dark:text-zinc-400">
            PDFをアップロードしてください
          </div>
        )}
      </div>
    </div>
  );
}
