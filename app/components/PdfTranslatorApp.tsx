"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import PdfOverlayViewer from "./PdfOverlayViewer";
import { analyzeDocument, translateGroups } from "@/app/lib/translate-client";
import type {
  DocumentAnalysis,
  LineGroup,
  SourceLang,
  TranslationEntry,
} from "@/app/lib/types";

const EXPERT_LABELS: Record<DocumentAnalysis["expert"], string> = {
  finance: "金融・会計",
  legal: "法務・契約",
  medical: "医療・薬事",
  technical: "技術・製造",
  general: "一般文書",
};

// UI用の短いラベル。api/translate/route.ts 側にプロンプト用の同名テーブルを
// 別途持つ（EXPERT_LABELSと同じく意図的な重複。用途ごとに独立させる）。
const SOURCE_LANG_LABELS: Record<SourceLang, string> = {
  vie: "ベトナム語",
  eng: "英語",
  mya: "ミャンマー語",
};
const SOURCE_LANG_OPTIONS: (SourceLang | null)[] = [null, "vie", "eng", "mya"];
// これ未満のOCR信頼度は、言語ミスマッチ等でOCRが破綻している可能性が高い。
const LOW_OCR_CONFIDENCE = 60;

export default function PdfTranslatorApp() {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationEntry>>({});
  const [showTranslation, setShowTranslation] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selectionMode, setSelectionMode] = useState(false);
  const [manualGroups, setManualGroups] = useState<LineGroup[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  // 「翻訳結果を削除」で非表示にした自動抽出グループのid集合。
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  // 全ページぶんの自動抽出グループを蓄積したもの（ページ完了ごとにhandleExtractedが更新）。
  // パス2の文脈適応翻訳で全体を対象に再翻訳する際に使う。
  const [extractedGroups, setExtractedGroups] = useState<LineGroup[]>([]);
  // ページ処理（テキスト抽出/OCR）の進捗。Viewerからのコールバックで更新される。
  const [pageProgress, setPageProgress] = useState({ done: 0, total: 0 });
  // falseの間はViewerに新規ページの処理を開始させない（「処理を中断」）。
  const [processingEnabled, setProcessingEnabled] = useState(true);
  const [jumpInput, setJumpInput] = useState("");
  // パス2: 文書全体の文脈推定→文脈を踏まえた全体再翻訳。
  const [documentAnalysis, setDocumentAnalysis] = useState<DocumentAnalysis | null>(null);
  const [refineStatus, setRefineStatus] = useState<
    "idle" | "analyzing" | "refining" | "done" | "error"
  >("idle");
  const [refineError, setRefineError] = useState<string | null>(null);
  // パス2で今まさにLLMへ送信中のグループid（最大チャンクサイズぶん）。
  // オーバーレイ側で「処理対象」を光らせて示すために使う。
  const [refiningIds, setRefiningIds] = useState<Set<string>>(new Set());
  // ユーザーが明示的に選んだ原文言語。nullなら自動判定に従う。
  const [langOverride, setLangOverride] = useState<SourceLang | null>(null);
  // 抽出/OCR結果から自動判定した言語。判定できるまでnull。
  const [detectedLang, setDetectedLang] = useState<SourceLang | null>(null);
  // 実効言語。null は「未確定」＝OCRは判定兼用の複数言語同時読み、プロンプトは中立。
  const sourceLang = langOverride ?? detectedLang;
  // OCR（スキャンPDF）の平均信頼度。テキスト層抽出時はnullのまま。
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  // パス1（自動抽出/OCRトリガーの翻訳・手動領域・再翻訳）はすべて1本のコントローラで
  // 中断管理する。ドキュメント/言語が変わったら丸ごと中断し、新しいコントローラに差し替える。
  const abortRef = useRef<AbortController | null>(null);
  // パス2（文脈適応の全体再翻訳）専用のコントローラ。
  const refineAbortRef = useRef<AbortController | null>(null);
  // llama.cppは単一インスタンスのため、複数ページぶんの翻訳リクエストが同時に
  // 飛ばないよう、パス1の翻訳（ページ抽出/手動領域/再翻訳）は全てこのキューで直列化する。
  const translateQueueRef = useRef<Promise<void>>(Promise.resolve());
  // キューに積まれている（実行中含む）パス1翻訳タスクの件数。0になれば「翻訳待ちなし」。
  const [pendingTranslateCount, setPendingTranslateCount] = useState(0);
  // パス1翻訳の重複除去キャッシュ（原文テキスト -> 結果）。ページをまたいで同じ文字列
  // （明細票の"Total"等）が繰り返されやすいため、ページごとにtranslateGroupsを呼んでも
  // 重複リクエストが起きないようドキュメント単位で共有する。
  const pass1CacheRef = useRef(new Map<string, TranslationEntry>());
  // パス2（文脈適応翻訳）用の重複除去キャッシュ。パス2は現状1文書につき1回の呼び出しだが、
  // パス1と対称に持たせておく。
  const pass2CacheRef = useRef(new Map<string, TranslationEntry>());

  const failedCount = Object.values(translations).filter((t) => t.failed).length;
  const totalTranslatable = extractedGroups.filter((g) => g.translatable).length;
  const translatedCount = extractedGroups.filter(
    (g) => g.translatable && translations[g.id] !== undefined
  ).length;
  const allPagesProcessed = pageProgress.total > 0 && pageProgress.done === pageProgress.total;
  const pass1Done = allPagesProcessed && pendingTranslateCount === 0;
  const refineTargetCount = [
    ...extractedGroups.filter((g) => !dismissedIds.has(g.id)),
    ...manualGroups,
  ].filter((g) => g.translatable).length;

  // パス1翻訳タスクを直列キューへ積む。同時に複数ページの翻訳リクエストが
  // llama.cppへ飛ばないようにするための共通ヘルパー。
  const enqueueTranslate = useCallback((task: () => Promise<void>) => {
    setPendingTranslateCount((c) => c + 1);
    const run = () => task().finally(() => setPendingTranslateCount((c) => Math.max(0, c - 1)));
    const next = translateQueueRef.current.then(run, run);
    translateQueueRef.current = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }, []);

  const loadFile = useCallback(async (buffer: ArrayBuffer, name: string) => {
    abortRef.current?.abort();
    refineAbortRef.current?.abort();
    abortRef.current = new AbortController();
    translateQueueRef.current = Promise.resolve();
    pass1CacheRef.current = new Map();
    pass2CacheRef.current = new Map();
    setData(buffer);
    setFileName(name);
    setTranslations({});
    setManualGroups([]);
    setDismissedIds(new Set());
    setExtractedGroups([]);
    setPageProgress({ done: 0, total: 0 });
    setProcessingEnabled(true);
    setPendingTranslateCount(0);
    setDocumentAnalysis(null);
    setRefineStatus("idle");
    setRefineError(null);
    setRefiningIds(new Set());
    setSelectionMode(false);
    setErrorMessage(null);
    setZoom(1);
    setLangOverride(null);
    setDetectedLang(null);
    setOcrConfidence(null);
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

  // ページの抽出（テキスト層/OCR）が1ページ終わるたびにViewerから呼ばれる。
  // そのページぶんの抽出結果でextractedGroupsを差し替え（言語変更等での再抽出にも対応）、
  // 翻訳キューへ積む。
  const handleExtracted = useCallback(
    (pageIndex: number, groups: LineGroup[]) => {
      setExtractedGroups((prev) => [
        ...prev.filter((g) => g.pageIndex !== pageIndex),
        ...groups,
      ]);
      if (groups.length === 0) return;

      const controller = abortRef.current;
      if (!controller) return;
      enqueueTranslate(() =>
        translateGroups(
          groups,
          (partial) => {
            startTransition(() => {
              setTranslations((prev) => ({ ...prev, ...partial }));
            });
          },
          controller.signal,
          { sourceLang, cache: pass1CacheRef.current }
        ).catch((e) => {
          if (!controller.signal.aborted) {
            setErrorMessage(e instanceof Error ? e.message : String(e));
          }
        })
      );
    },
    [sourceLang, enqueueTranslate]
  );

  const handleManualRegion = useCallback(
    (group: LineGroup) => {
      setManualGroups((prev) => [...prev, group]);
      const controller = abortRef.current;
      if (!controller) return;
      enqueueTranslate(() =>
        translateGroups(
          [group],
          (partial) => {
            startTransition(() => {
              setTranslations((prev) => ({ ...prev, ...partial }));
            });
          },
          controller.signal,
          { sourceLang, cache: pass1CacheRef.current }
        ).catch((e) => {
          // 手動領域の翻訳失敗は致命的ではないので、原文フォールバックのまま留める。
          if (!controller.signal.aborted) {
            console.error("手動領域の翻訳に失敗しました:", e);
          }
        })
      );
    },
    [sourceLang, enqueueTranslate]
  );

  const clearManualRegions = useCallback(() => {
    const manualIds = new Set(manualGroups.map((g) => g.id));
    setManualGroups([]);
    // 手動グループぶんの翻訳結果だけを取り除く。
    setTranslations((prev) => {
      const next: Record<string, TranslationEntry> = {};
      for (const [id, entry] of Object.entries(prev)) {
        if (!manualIds.has(id)) next[id] = entry;
      }
      return next;
    });
  }, [manualGroups]);

  const handleRetranslate = useCallback(
    (group: LineGroup) => {
      // いったん翻訳結果を消して「翻訳待ち」表示に戻し、同じテキストをLLMへ送り直す。
      setTranslations((prev) => {
        const next = { ...prev };
        delete next[group.id];
        return next;
      });
      const controller = abortRef.current;
      if (!controller) return;
      enqueueTranslate(() =>
        // 再翻訳は「同じキャッシュ結果をもう一度返すだけ」にならないよう、
        // 共有キャッシュ(pass1CacheRef)を使わず必ず新規にLLMへ問い合わせる。
        translateGroups(
          [group],
          (partial) => {
            startTransition(() => {
              setTranslations((prev) => ({ ...prev, ...partial }));
            });
          },
          controller.signal,
          { sourceLang }
        ).catch((e) => {
          if (!controller.signal.aborted) {
            console.error("再翻訳に失敗しました:", e);
          }
        })
      );
    },
    [sourceLang, enqueueTranslate]
  );

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
    setRefiningIds(new Set());

    // 文脈推定には原文と現時点の訳文のペアを渡す。誤訳が混じっていても、
    // 原文も一緒に見せることで文書全体の分野を推定しやすくする狙い。
    const lines = targets.map((g) => {
      const t = translations[g.id];
      return t ? `${g.text} → ${t.text}` : g.text;
    });

    analyzeDocument(lines, controller.signal, sourceLang)
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
              // 文脈適応翻訳（パス2）で更新された結果には refined: true を付け、
              // 更新前の訳文（パス1時点のtext）を previousText として残す。
              // オーバーレイ側はこの2つを文字単位で比較し、変わった箇所だけ赤字にする。
              setTranslations((prev) => {
                const next = { ...prev };
                for (const [id, entry] of Object.entries(partial)) {
                  next[id] = { ...entry, refined: true, previousText: prev[id]?.text };
                }
                return next;
              });
            });
          },
          controller.signal,
          {
            context: analysis.summary,
            expert: analysis.expert,
            sourceLang,
            cache: pass2CacheRef.current,
            // 各チャンクの送信直前にidを通知してもらい、そのチャンクぶんのボックスを
            // 「処理対象」として強調表示する。次のチャンクが始まれば自動的に入れ替わる。
            onChunkStart: (ids) => setRefiningIds(new Set(ids)),
          }
        ).then(() => {
          if (!controller.signal.aborted) {
            setRefineStatus("done");
            setRefiningIds(new Set());
          }
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setRefineStatus("error");
          setRefiningIds(new Set());
          setRefineError(e instanceof Error ? e.message : String(e));
        }
      });
  }, [extractedGroups, manualGroups, dismissedIds, translations, sourceLang]);

  // Spaceキーで日本語オーバーレイの表示/非表示を切り替える。
  // フォーム要素にフォーカスがある間はSpaceキー本来の挙動（ボタン押下・チェック等）を優先し、
  // それ以外の場合のみページスクロールを止めてトグルする。
  useEffect(() => {
    if (!data) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "BUTTON" ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setShowTranslation((v) => !v);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [data]);

  const handleDismiss = useCallback(
    (id: string) => {
      // 翻訳結果を消し、ボックス自体も非表示にする。
      // この後ユーザーが「OCRエリア指定」で同じ場所を囲み直せば、新しい手動グループとして再翻訳できる。
      setTranslations((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (manualGroups.some((g) => g.id === id)) {
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
    },
    [manualGroups]
  );

  // 抽出/OCR結果から言語を推定できたときViewerから呼ばれる。自動判定は1文書に
  // つき1回だけ採用する（複数ページ・複数回呼ばれても上書きしない）。
  // 手動選択があればそちらが優先される（sourceLang = langOverride ?? detectedLang）ため、
  // ここでは常に detectedLang を更新してよい。
  const handleDetectedLang = useCallback((lang: SourceLang) => {
    setDetectedLang((prev) => prev ?? lang);
  }, []);

  const handleOcrConfidence = useCallback((confidence: number | null) => {
    setOcrConfidence(confidence);
  }, []);

  const handlePageProgress = useCallback((done: number, total: number) => {
    setPageProgress({ done, total });
  }, []);

  const handleJump = useCallback(() => {
    const n = Number(jumpInput);
    if (!Number.isInteger(n) || n < 1) return;
    document
      .getElementById(`pdf-page-${n}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [jumpInput]);

  // 言語を手動で切り替える（自動判定に戻す場合はnullを渡す）。
  // loadFileと同じ範囲（data/fileName/zoomは保持）を初期化し、Viewer側の
  // 再抽出・再OCRをトリガーする。以降の再翻訳は sourceLang の変更をきっかけに
  // handleExtracted 等が自動的に走る。
  const handleChangeSourceLang = useCallback((lang: SourceLang | null) => {
    abortRef.current?.abort();
    refineAbortRef.current?.abort();
    abortRef.current = new AbortController();
    translateQueueRef.current = Promise.resolve();
    pass1CacheRef.current = new Map();
    pass2CacheRef.current = new Map();
    setLangOverride(lang);
    setDetectedLang(null);
    setOcrConfidence(null);
    setTranslations({});
    setManualGroups([]);
    setDismissedIds(new Set());
    setPendingTranslateCount(0);
    setProcessingEnabled(true);
    setDocumentAnalysis(null);
    setRefineStatus("idle");
    setRefineError(null);
    setRefiningIds(new Set());
    setErrorMessage(null);
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center gap-6 bg-zinc-50 px-6 py-10 dark:bg-black">
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          外国語PDF 日本語オーバーレイ翻訳
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          ベトナム語・英語・ミャンマー語のPDF（複数ページ対応）を読み込むと、常駐中のローカルLLM
          （llama.cpp / gemma-4-12b）が日本語に翻訳し、元のレイアウトの上に重ねて表示します。
          原文の言語は自動判定されますが、下の「原文の言語」から手動でも選べます。
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
              <span className="text-xs text-zinc-400">(Spaceキーで切替)</span>
            </label>
          )}
        </div>

        {fileName && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            読み込み中: {fileName}
            {pageProgress.total > 0 && (
              <>
                {" "}
                ・解析 {pageProgress.done}/{pageProgress.total}ページ
              </>
            )}
            {totalTranslatable > 0 && (
              <>
                {" "}
                ・翻訳 {translatedCount}/{totalTranslatable}件
              </>
            )}
            {!processingEnabled && !allPagesProcessed && " ・処理を中断中"}
            {pass1Done && failedCount === 0 && " ・翻訳完了"}
            {pass1Done &&
              failedCount > 0 &&
              ` ・翻訳完了（${failedCount}件はローカルLLMの応答が得られず原文のままです。オレンジ色の枠が対象です）`}
            {errorMessage && ` ・エラー: ${errorMessage}`}
          </p>
        )}

        {data && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
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

            {pageProgress.total > 0 && (
              <>
                <span className="ml-4 text-zinc-500 dark:text-zinc-400">ページ移動:</span>
                <input
                  type="number"
                  min={1}
                  max={pageProgress.total}
                  value={jumpInput}
                  onChange={(e) => setJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleJump();
                  }}
                  placeholder={`1〜${pageProgress.total}`}
                  className="w-20 rounded border border-black/[.15] px-2 py-1 text-xs dark:border-white/[.15] dark:bg-transparent"
                />
                <button
                  type="button"
                  onClick={handleJump}
                  className="rounded border border-black/[.15] px-2 py-1 text-xs hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
                >
                  移動
                </button>
              </>
            )}

            {!allPagesProcessed && (
              <button
                type="button"
                onClick={() => setProcessingEnabled((v) => !v)}
                className="ml-auto rounded-full border border-black/[.15] px-4 py-1.5 text-sm font-medium hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
              >
                {processingEnabled ? "処理を中断" : "処理を再開"}
              </button>
            )}
          </div>
        )}

        {data && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">原文の言語:</span>
            {SOURCE_LANG_OPTIONS.map((lang) => (
              <button
                key={lang ?? "auto"}
                type="button"
                onClick={() => handleChangeSourceLang(lang)}
                aria-pressed={langOverride === lang}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  langOverride === lang
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "border border-black/[.15] hover:bg-black/[.04] dark:border-white/[.15] dark:hover:bg-[#1a1a1a]"
                }`}
              >
                {lang === null ? "自動" : SOURCE_LANG_LABELS[lang]}
              </button>
            ))}
            {langOverride === null && detectedLang && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                （自動判定: {SOURCE_LANG_LABELS[detectedLang]}）
              </span>
            )}
          </div>
        )}

        {data && ocrConfidence !== null && ocrConfidence < LOW_OCR_CONFIDENCE && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            OCRの信頼度が低いです（{Math.round(ocrConfidence)}）。上の「原文の言語」を選び直すと改善する場合があります。
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

        {data && (pass1Done || refineStatus !== "idle") && (
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
                    : `文脈を踏まえて全体を再翻訳（対象 ${refineTargetCount}件）`}
              </button>
              <span className="text-xs text-blue-800 dark:text-blue-300">
                単語ごとの独立翻訳を、文書全体の文脈を踏まえて見直します（件数が多いと数分かかります）
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
            <span className="flex items-center gap-1.5">
              <span className="font-semibold text-red-600">あ</span>
              文脈を踏まえて再翻訳された訳文
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-3 rounded-sm border-2 border-[#a855f7]"
                style={{ boxShadow: "0 0 6px 2px rgba(168,85,247,0.6)" }}
              />
              今まさに再翻訳中の項目
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
            sourceLang={sourceLang}
            onDetectedLang={handleDetectedLang}
            onOcrConfidence={handleOcrConfidence}
            selectionMode={selectionMode}
            manualGroups={manualGroups}
            onManualRegion={handleManualRegion}
            dismissedIds={dismissedIds}
            onRetranslate={handleRetranslate}
            onDismiss={handleDismiss}
            processingEnabled={processingEnabled}
            onPageProgress={handlePageProgress}
            refiningIds={refiningIds}
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
