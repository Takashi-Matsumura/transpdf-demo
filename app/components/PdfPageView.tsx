"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { diffChars } from "@/app/lib/diff";
import type { Box, LineGroup, TranslationEntry } from "@/app/lib/types";

// ページの処理状態。PdfOverlayViewer（ドキュメント担当）が各ページの進行を見て決める。
// "error" はテキスト抽出/OCRが例外で失敗し、このページはあきらめて次へ進んだ状態
// （1ページの失敗でドキュメント全体の処理が止まらないようにするためのフォールバック）。
export type PdfPageStatus = "pending" | "processing" | "done" | "error";

// pdfjsのRenderTask（render()の戻り値）のうち、このコンポーネントで使う部分のみを表す。
// スクロールで画面外に出たページの描画を中断するため cancel() を使う。
export type PdfRenderTask = {
  promise: Promise<void>;
  cancel(): void;
};

// pdfjsのPDFPageProxyのうち、このコンポーネントで使う部分だけを構造的に表した型。
export type RenderablePage = {
  getViewport(params: { scale: number; rotation?: number }): { width: number; height: number };
  render(params: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): PdfRenderTask;
};

type Props = {
  page: RenderablePage;
  pageIndex: number;
  pageCount: number;
  /** page.getViewport({ scale }) の scale。SCALE定数はViewer側で一元管理し、ここへ渡す。 */
  scale: number;
  /**
   * page.getViewport に渡す絶対回転角（度）。スキャン画像自体が回転しているページを
   * 正立させるためにViewer側が検出した補正込みの絶対値。undefinedならpdfjs既定
   * （page.rotate、PDFの/Rotateメタデータ）で描画する。
   */
  rotation?: number;
  /** rotationがPDF自体の/Rotateではなく、内容の向き検出による補正を含む場合true。バッジ表示用。 */
  rotationCorrected?: boolean;
  /** scale適用後（ズーム前）のページサイズ。プレースホルダのレイアウトに使う。 */
  viewportSize: { width: number; height: number };
  zoom: number;
  /** このページに属する自動抽出グループ（テキスト層 or OCR）。未処理なら空配列。 */
  groups: LineGroup[];
  /** 全ページぶんの手動指定グループ。内部で pageIndex に一致するものだけ描画する。 */
  manualGroups: LineGroup[];
  translations: Record<string, TranslationEntry>;
  showTranslation: boolean;
  dismissedIds: Set<string>;
  onRetranslate: (group: LineGroup) => void;
  onDismiss: (id: string) => void;
  selectionMode: boolean;
  /** ドラッグで範囲指定が確定したときに呼ばれる（表示座標のBox、ズーム前）。 */
  onManualSelection: (pageIndex: number, box: Box) => void;
  status: PdfPageStatus;
  /** status==="processing" かつ 実際にOCRを実行中のときだけ設定される（probe/final）。 */
  ocrPhase?: "probe" | "final";
  /** このページで手動領域OCRが進行中かどうか。 */
  regionOcrRunning: boolean;
  /** このページの手動領域OCRで直近に発生したエラーメッセージ。 */
  regionError: string | null;
  /**
   * 「文脈を踏まえて全体を再翻訳」で、今まさにLLMへ送られているグループのid集合。
   * 該当するボックスをパルスするグローで強調表示する。
   */
  refiningIds: Set<string>;
  /**
   * trueの間は visible（画面内かどうか）に関わらず強制的に描画する。
   * 「PDFとして保存」の直前に、画面外で未描画（canvasが解放された状態）の
   * ページも含めて全ページを描画させるために使う。
   */
  forceRender?: boolean;
  /**
   * 描画が確定するたびに呼ばれる。ok=falseは中断または失敗（絵は無い）。
   * 印刷準備の「このページは処理済み」判定に使う。forceRenderが立った時点で
   * 既にこのページが描画済み（画面内で先に表示されていた等）だった場合も、
   * 改めてこのコールバックで通知する。
   */
  onRendered?: (pageIndex: number, ok: boolean) => void;
};

const MIN_SELECTION_PX = 8; // 誤クリックを手動選択として扱わないための最小サイズ（表示座標px）

type DragState = { startX: number; startY: number; curX: number; curY: number };

function normalizeRect(d: DragState): Box {
  return {
    left: Math.min(d.startX, d.curX),
    top: Math.min(d.startY, d.curY),
    width: Math.abs(d.curX - d.startX),
    height: Math.abs(d.curY - d.startY),
    angle: 0,
  };
}

// aの中心がbの矩形内に入っているか（表示座標）。
function centerInside(a: Box, b: Box): boolean {
  const cx = a.left + a.width / 2;
  const cy = a.top + a.height / 2;
  return cx >= b.left && cx <= b.left + b.width && cy >= b.top && cy <= b.top + b.height;
}

const STATUS_BADGE: Record<PdfPageStatus, { label: string; className: string }> = {
  pending: {
    label: "未処理",
    className: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  },
  processing: {
    label: "処理中…",
    className: "bg-amber-200 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  },
  done: {
    label: "完了",
    className: "bg-emerald-200 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300",
  },
  error: {
    label: "処理失敗",
    className: "bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-300",
  },
};

/**
 * PDF1ページぶんの描画・オーバーレイ表示・手動選択レイヤーを担当するコンポーネント。
 * 複数ページPDFで全ページぶんのcanvasを同時に保持するとメモリを圧迫するため、
 * IntersectionObserverで画面に近いページだけ実際にレンダリングし、離れたら解放する
 * （プレースホルダのサイズは常に確保するのでスクロール位置は飛ばない）。
 */
export default function PdfPageView({
  page,
  pageIndex,
  pageCount,
  scale,
  rotation,
  rotationCorrected,
  viewportSize,
  zoom,
  groups,
  manualGroups,
  translations,
  showTranslation,
  dismissedIds,
  onRetranslate,
  onDismiss,
  selectionMode,
  onManualSelection,
  status,
  ocrPhase,
  regionOcrRunning,
  regionError,
  refiningIds,
  forceRender,
  onRendered,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<PdfRenderTask | null>(null);
  const [visible, setVisible] = useState(false);

  const selectionLayerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // 画面に近づいたら visible=true、離れたら false。1200pxの先読みマージンで
  // スクロール中にちらつかない程度の余裕を持たせる。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: "1200px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // visible（画面内）またはforceRender（PDF保存直前の強制描画）のどちらかが立っていれば
  // 実描画する。この値そのもの（真偽値）を依存に使うのが重要 — [visible, forceRender] を
  // 別々に依存へ入れると、既に画面内で描画済みのページでもforceRenderがtrueになった
  // 瞬間にeffectが再実行され、無駄な再描画（cancel→再render）が走ってしまう
  // （このコードベースは同一ドキュメントへの同時render()でpdfjsが無応答になる不具合を
  // 実機で特定しており、印刷時に多数のページが一斉に無駄な再描画を始めるのは避けたい）。
  const active = visible || !!forceRender;

  // 今canvasに入っている絵がどの描画パラメータのものか（null=未描画）。
  // forceRenderが立った時点で「このページは既に描画済みか」を判定するために使う
  // （下のeffect）。
  const renderKey = `${scale}|${rotation ?? "auto"}`;
  const renderedKeyRef = useRef<string | null>(null);

  // 描画effectの依存にコールバックを直接入れると、親が再レンダーのたびに新しい
  // 関数を渡す場合にeffectが余計に再実行されうる。refで受け渡して切り離す。
  const onRenderedRef = useRef(onRendered);
  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  // visible/forceRenderの間だけcanvasへ実描画する。activeでなくなったら描画タスクを
  // 中断し、canvasのピクセルバッファを解放する（幅/高さを0にする既知の解放手段）。
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // React StrictMode（開発時）はeffectを一度破棄→再実行するため、破棄された側の
    // async関数はawaitの続きが実行され続ける。破棄済みインスタンスがonRenderedを
    // 呼んで印刷準備の判定を汚さないよう、ローカルフラグで見張る。
    let disposed = false;

    async function render() {
      const viewport = page.getViewport({ scale, rotation });
      canvas!.width = Math.floor(viewport.width);
      canvas!.height = Math.floor(viewport.height);
      const ctx = canvas!.getContext("2d");
      if (!ctx) return;
      const task = page.render({ canvas: canvas!, canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
        if (disposed) return;
        renderedKeyRef.current = renderKey;
        onRenderedRef.current?.(pageIndex, true);
      } catch {
        // 画面外へ出た際のcancel()による中断（RenderingCancelledException）と、
        // 実際の描画失敗の両方がここに来る。どちらも「この絵は使えない」で扱いは同じ。
        renderedKeyRef.current = null;
        if (!disposed) onRenderedRef.current?.(pageIndex, false);
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }
    }

    void render();

    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      renderedKeyRef.current = null;
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [active, page, scale, rotation, renderKey, pageIndex]);

  // forceRenderが立った時点で、上のeffectが（activeが既にtrueだったため）再実行
  // されず、このページが「既に描画済み」の場合がある。印刷準備側が「このページは
  // 準備済み」と判断できるよう、ここで改めて通知する。
  useEffect(() => {
    if (!forceRender) return;
    if (renderedKeyRef.current === renderKey) {
      onRenderedRef.current?.(pageIndex, true);
    }
  }, [forceRender, renderKey, pageIndex]);

  // 「一時メッセージは数秒で自動的に消す」は親（Viewer）側でregionErrorのライフサイクルを
  // 管理する想定だが、ここでは受け取った文字列をそのまま表示するだけに留める。

  function toDisplay(e: React.MouseEvent): { x: number; y: number } {
    const rect = selectionLayerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }

  function handleSelectionDown(e: React.MouseEvent) {
    if (!selectionMode) return;
    e.preventDefault();
    const p = toDisplay(e);
    setDrag({ startX: p.x, startY: p.y, curX: p.x, curY: p.y });
  }

  function handleSelectionMove(e: React.MouseEvent) {
    if (!drag) return;
    const p = toDisplay(e);
    setDrag((d) => (d ? { ...d, curX: p.x, curY: p.y } : d));
  }

  function handleSelectionUp() {
    if (!drag) return;
    const sel = normalizeRect(drag);
    setDrag(null);
    if (sel.width < MIN_SELECTION_PX || sel.height < MIN_SELECTION_PX) return;
    onManualSelection(pageIndex, sel);
  }

  const myManualGroups = useMemo(
    () => manualGroups.filter((g) => g.pageIndex === pageIndex),
    [manualGroups, pageIndex]
  );

  // 手動グループと大きく重なる自動グループ、およびユーザーが削除した自動グループは非表示にする。
  const overlaps = (a: Box, b: Box) => centerInside(a, b) || centerInside(b, a);
  const visibleAuto = groups.filter(
    (g) => !dismissedIds.has(g.id) && !myManualGroups.some((m) => overlaps(g.box, m.box))
  );
  const rendered = [...visibleAuto, ...myManualGroups].filter((g) => g.translatable);

  const badge = STATUS_BADGE[status];

  return (
    <div
      id={`pdf-page-${pageIndex}`}
      ref={containerRef}
      className="relative"
      style={{
        width: viewportSize.width ? viewportSize.width * zoom : undefined,
        height: viewportSize.height ? viewportSize.height * zoom : undefined,
      }}
    >
      <div className="absolute -top-6 left-0 flex items-center gap-2 text-xs text-zinc-500 print:hidden dark:text-zinc-400">
        <span>
          {pageIndex} / {pageCount}
        </span>
        <span className={`rounded-full px-2 py-0.5 font-medium ${badge.className}`}>
          {badge.label}
        </span>
        {rotationCorrected && (
          <span
            className="rounded-full bg-sky-200 px-2 py-0.5 font-medium text-sky-800 dark:bg-sky-900 dark:text-sky-300"
            title="スキャン画像の向きを検出し、正立するよう回転補正しています"
          >
            向きを補正
          </span>
        )}
      </div>
      <div
        className="relative bg-white shadow print-exact-colors print:shadow-none"
        style={{
          width: viewportSize.width || undefined,
          height: viewportSize.height || undefined,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}
      >
        <canvas ref={canvasRef} className="block" />
        {!visible && !forceRender && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-100 text-xs text-zinc-400 print:hidden dark:bg-zinc-900">
            スクロールして表示
          </div>
        )}
        {status === "processing" && ocrPhase && (
          <p className="absolute inset-x-0 top-0 z-20 bg-amber-100 p-2 text-center text-xs text-amber-800 print:hidden">
            {ocrPhase === "probe"
              ? "このPDFにはテキスト層がないため、原文の言語を判定しながらOCRしています（数十秒かかる場合があります）…"
              : "指定した言語でOCRを実行しています（数十秒かかる場合があります）…"}
          </p>
        )}
        {regionOcrRunning && (
          <p className="absolute inset-x-0 top-0 z-20 bg-blue-100 p-2 text-center text-xs text-blue-800 print:hidden">
            選択領域をOCRしています…
          </p>
        )}
        {regionError && (
          <p className="absolute inset-x-0 top-0 z-20 bg-amber-100 p-2 text-center text-xs text-amber-800 print:hidden">
            {regionError}
          </p>
        )}
        <div
          className="absolute inset-0"
          style={{ visibility: showTranslation ? "visible" : "hidden" }}
        >
          {rendered.map((g) => (
            <OverlayItem
              key={g.id}
              group={g}
              translation={translations[g.id]}
              onRetranslate={onRetranslate}
              onDismiss={onDismiss}
              refining={refiningIds.has(g.id)}
            />
          ))}
        </div>
        {selectionMode && (
          <div
            ref={selectionLayerRef}
            onMouseDown={handleSelectionDown}
            onMouseMove={handleSelectionMove}
            onMouseUp={handleSelectionUp}
            onMouseLeave={handleSelectionUp}
            className="absolute inset-0 z-10 print:hidden"
            style={{ cursor: "crosshair" }}
          >
            {drag &&
              (() => {
                const r = normalizeRect(drag);
                return (
                  <div
                    style={{
                      position: "absolute",
                      left: r.left,
                      top: r.top,
                      width: r.width,
                      height: r.height,
                      border: "1.5px dashed #2563eb",
                      background: "rgba(37,99,235,0.12)",
                      pointerEvents: "none",
                    }}
                  />
                );
              })()}
          </div>
        )}
      </div>
    </div>
  );
}

function OverlayItem({
  group,
  translation,
  onRetranslate,
  onDismiss,
  refining,
}: {
  group: LineGroup;
  translation: TranslationEntry | undefined;
  onRetranslate: (group: LineGroup) => void;
  onDismiss: (id: string) => void;
  /** 「文脈を踏まえて全体を再翻訳」で、今まさにLLMへ送られている最中かどうか。 */
  refining: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scaleX, setScaleX] = useState(1);
  const [hovered, setHovered] = useState(false);
  const text = translation?.text ?? group.text;
  const loading = translation === undefined;
  const failed = translation?.failed ?? false;
  // 「文脈を踏まえて全体を再翻訳」（パス2）で見直された訳文かどうか。
  // 枠・背景は既存の状態表示のまま、文字色だけ赤にして見分けられるようにする。
  const refined = translation?.refined ?? false;
  // refined時、更新前(previousText)と現在(text)を文字単位で比較し、実際に
  // 変わった区間だけ抽出する。previousTextが無い/完全一致なら差分なし(通常表示)。
  const diffSegments =
    refined && translation?.previousText && translation.previousText !== text
      ? diffChars(translation.previousText, text)
      : null;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setScaleX(1);
    const raw = el.scrollWidth;
    if (raw > group.box.width && raw > 0) {
      setScaleX(Math.max(group.box.width / raw, 0.4));
    }
  }, [text, group.box.width]);

  const { box } = group;
  const fontSize = Math.max(box.height * 0.85, 8);
  // 翻訳ボックスだと一目でわかるよう、状態ごとに塗り＋枠線で強調する。
  // 黄色=翻訳待ち、水色=ローカルLLMによる翻訳成功、オレンジ=応答が得られず原文のまま
  const { background, border } = loading
    ? { background: "#fef9c3", border: "1.5px dashed #ca8a04" }
    : failed
      ? { background: "#fed7aa", border: "1.5px dashed #ea580c" }
      : { background: "#dbeafe", border: "1.5px solid #2563eb" };
  // 「文脈を踏まえて全体を再翻訳」で今まさに送信中のグループは、状態表示より優先して
  // 紫の呼吸するグローで強調する（Claudeの思考中インジケータを参考にした表現）。
  const refiningStyle: React.CSSProperties | undefined = refining
    ? { border: "2px solid #a855f7", animation: "refine-glow 1.3s ease-in-out infinite" }
    : undefined;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={
        refining
          ? "文脈を踏まえて再翻訳中です…"
          : failed
            ? "ローカルLLMからの応答が得られなかったため原文を表示しています（ホバーで再翻訳・削除）"
            : loading
              ? "翻訳待ちです"
              : refined
                ? "文脈を踏まえて全体を再翻訳した結果です（赤字表示・ホバーで再翻訳・削除）"
                : "ローカルLLMによる翻訳です（ホバーで再翻訳・削除）"
      }
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        // 文字がボックス高より大きくなる場合に縦方向で欠けないよう、
        // 最小高さだけ指定して実際の高さはコンテンツに合わせて伸ばす。
        minHeight: box.height,
        height: "auto",
        display: "flex",
        alignItems: "center",
        padding: "1px 2px",
        background,
        border,
        boxSizing: "border-box",
        boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        ...refiningStyle,
        overflow: "visible",
        transform: box.angle ? `rotate(${box.angle}rad)` : undefined,
        transformOrigin: "left top",
      }}
    >
      <div
        ref={ref}
        style={{
          display: "inline-block",
          whiteSpace: "nowrap",
          fontSize,
          lineHeight: 1.3,
          color: "#111111",
          transform: scaleX < 1 ? `scaleX(${scaleX})` : undefined,
          transformOrigin: "left top",
        }}
      >
        {diffSegments
          ? // 文脈適応翻訳（パス2）で実際に変わった区間だけ赤字にする。
            // 変わっていない区間はそのまま黒字（旧訳と同じ）。
            diffSegments.map((seg, i) => (
              <span
                key={i}
                style={
                  seg.changed
                    ? { color: "#dc2626", fontWeight: 600 }
                    : undefined
                }
              >
                {seg.text}
              </span>
            ))
          : text}
      </div>
      {!loading && hovered && (
        <div
          className="absolute -top-2.5 -right-2.5 z-30 flex gap-1 print:hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            title="再翻訳する"
            onClick={(e) => {
              e.stopPropagation();
              onRetranslate(group);
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-blue-500 bg-white text-[11px] leading-none text-blue-700 shadow hover:bg-blue-50"
          >
            ⟲
          </button>
          <button
            type="button"
            title="この翻訳結果を削除する（削除後、OCRエリア指定で範囲を囲み直すと再翻訳できます）"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(group.id);
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-red-500 bg-white text-[11px] leading-none text-red-700 shadow hover:bg-red-50"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
