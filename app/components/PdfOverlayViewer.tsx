"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { groupTextItems, loadPdfjs } from "@/app/lib/pdf";
import { runOcr, runOcrRegion } from "@/app/lib/ocr";
import type { Box, LineGroup, TranslationEntry } from "@/app/lib/types";

type Props = {
  /** 表示するPDFの生データ */
  data: ArrayBuffer;
  /** 訳が用意できたグループごとの翻訳結果（id -> 結果） */
  translations: Record<string, TranslationEntry>;
  /** trueなら日本語オーバーレイを表示、falseなら原文のまま */
  showTranslation: boolean;
  /** 表示倍率。1 が等倍。 */
  zoom: number;
  /** 抽出したテキストグループを親へ通知（翻訳リクエストのトリガー用） */
  onExtracted: (groups: LineGroup[]) => void;
  /** trueならマウスドラッグでOCR領域を追加指定できる */
  selectionMode: boolean;
  /** 手動指定で追加されたグループ（親が保持。描画用） */
  manualGroups: LineGroup[];
  /** 手動領域のOCRが成功したとき、生成した1グループを親へ通知 */
  onManualRegion: (group: LineGroup) => void;
};

const SCALE = 1.5;
// OCRは低解像度だと精度が大きく落ちるため、表示用よりも高い解像度で別途レンダリングする。
const OCR_SCALE = 3;
// 誤クリックを手動選択として扱わないための最小サイズ（表示座標px）。
const MIN_SELECTION_PX = 8;

// pdfjsのPDFPageProxyのうち、このコンポーネントで使う部分だけを構造的に表した型。
// 型は動的importで得られるため、必要なメソッドのみを最小限で宣言する。
type RenderablePage = {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
};

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

export default function PdfOverlayViewer({
  data,
  translations,
  showTranslation,
  zoom,
  onExtracted,
  selectionMode,
  manualGroups,
  onManualRegion,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [groups, setGroups] = useState<LineGroup[]>([]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);

  // 手動OCR領域指定まわり
  const pageRef = useRef<RenderablePage | null>(null);
  // 手動選択のたびにフルページを高解像度で描き直すのは無駄なので、初回に一度だけ生成してキャッシュする。
  const ocrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const manualIdRef = useRef(0);
  const selectionLayerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [regionOcrRunning, setRegionOcrRunning] = useState(false);
  const [regionError, setRegionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      setError(null);
      try {
        const pdfjs = await loadPdfjs();
        // getDocument は渡した ArrayBuffer を detach/transfer することがあるため複製して渡す
        const doc = await pdfjs.getDocument({
          data: data.slice(0),
          cMapUrl: "/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/standard_fonts/",
        }).promise;

        const page = await doc.getPage(1);
        // 手動領域OCRで再利用するためページを保持し、前のドキュメントの高解像度キャッシュは破棄する。
        pageRef.current = page as unknown as RenderablePage;
        ocrCanvasRef.current = null;
        const viewport = page.getViewport({ scale: SCALE });

        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        setViewportSize({ width: viewport.width, height: viewport.height });

        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        let extracted = groupTextItems(pdfjs, textContent.items, viewport);

        if (extracted.length === 0) {
          // テキスト層が存在しない（スキャン/画像ベースの）PDF。OCRにフォールバックする。
          setOcrRunning(true);
          try {
            const ocrViewport = page.getViewport({ scale: OCR_SCALE });
            const ocrCanvas = document.createElement("canvas");
            ocrCanvas.width = Math.floor(ocrViewport.width);
            ocrCanvas.height = Math.floor(ocrViewport.height);
            const ocrCtx = ocrCanvas.getContext("2d");
            if (ocrCtx) {
              await page.render({
                canvas: ocrCanvas,
                canvasContext: ocrCtx,
                viewport: ocrViewport,
              }).promise;
              if (cancelled) return;
              extracted = await runOcr(ocrCanvas, SCALE / OCR_SCALE);
            }
          } finally {
            if (!cancelled) setOcrRunning(false);
          }
        }

        if (cancelled) return;
        setGroups(extracted);
        onExtracted(extracted);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }

    render();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // 「文字を検出できませんでした」等の一時メッセージは数秒で自動的に消す。
  useEffect(() => {
    if (!regionError) return;
    const t = setTimeout(() => setRegionError(null), 3500);
    return () => clearTimeout(t);
  }, [regionError]);

  // マウスのclient座標を表示座標（SCALE空間・ズーム前）へ変換する。
  // 選択レイヤーはCSS transform: scale(zoom) された内側divの中にあるため、
  // getBoundingClientRect はズーム込みの実寸を返す。zoomで割ってズーム前の座標に戻す。
  function toDisplay(e: React.MouseEvent): { x: number; y: number } {
    const rect = selectionLayerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }

  function handleSelectionDown(e: React.MouseEvent) {
    if (!selectionMode) return;
    e.preventDefault();
    setRegionError(null);
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
    void runRegionOcr(sel);
  }

  async function runRegionOcr(sel: Box) {
    const page = pageRef.current;
    if (!page) return;
    setRegionError(null);
    setRegionOcrRunning(true);
    try {
      // フルページを高解像度で描いたcanvasをキャッシュ（初回のみ生成）。
      let full = ocrCanvasRef.current;
      if (!full) {
        const vp = page.getViewport({ scale: OCR_SCALE });
        full = document.createElement("canvas");
        full.width = Math.floor(vp.width);
        full.height = Math.floor(vp.height);
        const fctx = full.getContext("2d");
        if (!fctx) throw new Error("canvasコンテキストの取得に失敗しました");
        await page.render({ canvas: full, canvasContext: fctx, viewport: vp }).promise;
        ocrCanvasRef.current = full;
      }

      // 表示座標 → 高解像度canvasのピクセル座標（×OCR_SCALE/SCALE）。canvas範囲内にクランプする。
      const ratio = OCR_SCALE / SCALE;
      const sx = Math.max(0, Math.floor(sel.left * ratio));
      const sy = Math.max(0, Math.floor(sel.top * ratio));
      const sw = Math.min(full.width - sx, Math.ceil(sel.width * ratio));
      const sh = Math.min(full.height - sy, Math.ceil(sel.height * ratio));
      if (sw <= 0 || sh <= 0) return;

      const crop = document.createElement("canvas");
      crop.width = sw;
      crop.height = sh;
      const cctx = crop.getContext("2d");
      if (!cctx) throw new Error("canvasコンテキストの取得に失敗しました");
      cctx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);

      const id = `manual-${manualIdRef.current++}`;
      const group = await runOcrRegion(
        crop,
        SCALE / OCR_SCALE,
        { left: sel.left, top: sel.top },
        id
      );
      if (group) {
        onManualRegion(group);
      } else {
        setRegionError("この範囲から翻訳できる文字を検出できませんでした");
      }
    } catch (e) {
      setRegionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegionOcrRunning(false);
    }
  }

  // 手動グループと大きく重なる自動グループは非表示にして、手動ボックスで置き換える。
  // 置き換えは描画抑制のみ（自動グループのstateや翻訳結果は保持したまま）。
  const overlaps = (a: Box, b: Box) => centerInside(a, b) || centerInside(b, a);
  const visibleAuto = groups.filter(
    (g) => !manualGroups.some((m) => overlaps(g.box, m.box))
  );
  const rendered = [...visibleAuto, ...manualGroups].filter((g) => g.translatable);

  return (
    // 外側: ズーム後の実サイズぶんレイアウト領域を確保する（スクロールを正しく機能させるため）
    <div
      style={{
        width: viewportSize.width ? viewportSize.width * zoom : undefined,
        height: viewportSize.height ? viewportSize.height * zoom : undefined,
      }}
    >
      {/* 内側: 座標計算はズーム前のまま。CSS transformで見た目だけ拡大縮小する */}
      <div
        className="relative bg-white shadow"
        style={{
          width: viewportSize.width || undefined,
          height: viewportSize.height || undefined,
          transform: `scale(${zoom})`,
          transformOrigin: "top left",
        }}
      >
        <canvas ref={canvasRef} className="block" />
        {ocrRunning && (
          <p className="absolute inset-x-0 top-0 z-20 bg-amber-100 p-2 text-center text-xs text-amber-800">
            このPDFにはテキスト層がないため、OCRでテキストを抽出しています（数十秒かかる場合があります）…
          </p>
        )}
        {regionOcrRunning && (
          <p className="absolute inset-x-0 top-0 z-20 bg-blue-100 p-2 text-center text-xs text-blue-800">
            選択領域をOCRしています…
          </p>
        )}
        {regionError && (
          <p className="absolute inset-x-0 top-0 z-20 bg-amber-100 p-2 text-center text-xs text-amber-800">
            {regionError}
          </p>
        )}
        {error && (
          <p className="absolute inset-0 flex items-center justify-center bg-white/90 p-4 text-sm text-red-600">
            PDFの表示に失敗しました: {error}
          </p>
        )}
        <div
          className="absolute inset-0"
          style={{ visibility: showTranslation ? "visible" : "hidden" }}
        >
          {rendered.map((g) => (
            <OverlayItem key={g.id} group={g} translation={translations[g.id]} />
          ))}
        </div>
        {selectionMode && (
          // 最前面でマウスドラッグを受け取り、翻訳ボックスより上に選択矩形を描く。
          <div
            ref={selectionLayerRef}
            onMouseDown={handleSelectionDown}
            onMouseMove={handleSelectionMove}
            onMouseUp={handleSelectionUp}
            onMouseLeave={handleSelectionUp}
            className="absolute inset-0 z-10"
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
}: {
  group: LineGroup;
  translation: TranslationEntry | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scaleX, setScaleX] = useState(1);
  const text = translation?.text ?? group.text;
  const loading = translation === undefined;
  const failed = translation?.failed ?? false;

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

  return (
    <div
      title={
        failed
          ? "ローカルLLMからの応答が得られなかったため原文を表示しています"
          : loading
            ? "翻訳待ちです"
            : "ローカルLLMによる翻訳です"
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
        {text}
      </div>
    </div>
  );
}
