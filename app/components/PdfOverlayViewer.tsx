"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { groupTextItems, loadPdfjs } from "@/app/lib/pdf";
import { runOcr } from "@/app/lib/ocr";
import type { LineGroup, TranslationEntry } from "@/app/lib/types";

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
};

const SCALE = 1.5;
// OCRは低解像度だと精度が大きく落ちるため、表示用よりも高い解像度で別途レンダリングする。
const OCR_SCALE = 3;

export default function PdfOverlayViewer({
  data,
  translations,
  showTranslation,
  zoom,
  onExtracted,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [groups, setGroups] = useState<LineGroup[]>([]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const [ocrRunning, setOcrRunning] = useState(false);

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
          <p className="absolute inset-x-0 top-0 bg-amber-100 p-2 text-center text-xs text-amber-800">
            このPDFにはテキスト層がないため、OCRでテキストを抽出しています（数十秒かかる場合があります）…
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
          {groups
            .filter((g) => g.translatable)
            .map((g) => (
              <OverlayItem key={g.id} group={g} translation={translations[g.id]} />
            ))}
        </div>
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
