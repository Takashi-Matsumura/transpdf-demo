"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type * as PdfjsNS from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import PdfPageView, { type PdfPageStatus, type RenderablePage } from "./PdfPageView";
import { detectSourceLang, groupTextItems, loadPdfjs } from "@/app/lib/pdf";
import { detectPageRotation, runOcr, runOcrRegion } from "@/app/lib/ocr";
import type { Box, LineGroup, PageRotation, SourceLang, TranslationEntry } from "@/app/lib/types";

type Props = {
  /** 表示するPDFの生データ */
  data: ArrayBuffer;
  /** 訳が用意できたグループごとの翻訳結果（id -> 結果） */
  translations: Record<string, TranslationEntry>;
  /** trueなら日本語オーバーレイを表示、falseなら原文のまま */
  showTranslation: boolean;
  /** 表示倍率。1 が等倍。 */
  zoom: number;
  /**
   * あるページの抽出（テキスト層/OCR）が終わるたびに、そのページぶんのグループを親へ通知する。
   * groupsが空（文字を検出できなかったページ）の場合も呼ばれる — 親側で「そのページ分の
   * 古い抽出結果を消す」判断ができるよう、pageIndexは常に明示的に渡す。
   */
  onExtracted: (pageIndex: number, groups: LineGroup[]) => void;
  /**
   * 原文の言語。手動選択されていれば確定値、未選択かつ自動判定済みなら推定値、
   * どちらもまだなら null（OCR時は判定兼用の複数言語同時読みになる）。
   */
  sourceLang: SourceLang | null;
  /** 抽出/OCR結果から言語を推定できたときに呼ばれる（手動選択があれば呼び出し側で無視してよい） */
  onDetectedLang: (lang: SourceLang) => void;
  /** OCRの平均信頼度が得られるたびに呼ばれる（低信頼度の警告表示用）。テキスト層抽出時はnull。 */
  onOcrConfidence?: (confidence: number | null) => void;
  /** trueならマウスドラッグでOCR領域を追加指定できる */
  selectionMode: boolean;
  /** 手動指定で追加されたグループ（親が保持。描画用） */
  manualGroups: LineGroup[];
  /** 手動領域のOCRが成功したとき、生成した1グループを親へ通知 */
  onManualRegion: (group: LineGroup) => void;
  /** ユーザーが削除した自動抽出グループのid集合。該当グループの描画を抑制する */
  dismissedIds: Set<string>;
  /** 失敗ボックスの「再翻訳」ボタンが押されたとき、対象グループを親へ通知 */
  onRetranslate: (group: LineGroup) => void;
  /** 失敗ボックスの「削除」ボタンが押されたとき、対象idを親へ通知 */
  onDismiss: (id: string) => void;
  /** falseの間は新規ページの処理（テキスト抽出/OCR）を開始しない（「処理を中断」）。表示・手動操作は継続できる。 */
  processingEnabled: boolean;
  /** ページ単位の処理進捗。done: 処理済みページ数、total: 全ページ数。 */
  onPageProgress?: (done: number, total: number) => void;
  /**
   * 「文脈を踏まえて全体を再翻訳」で、今まさにLLMへ送られているグループのid集合。
   * 該当するボックスをパルスするグローで強調表示する。
   */
  refiningIds: Set<string>;
};

const SCALE = 1.5;
// OCRは低解像度だと精度が大きく落ちるため、表示用よりも高い解像度で別途レンダリングする。
const OCR_SCALE = 3;
// 回転検出は「どの向きが最もよく読めるか」の相対比較なので、本OCR(OCR_SCALE=3)ほどの
// 解像度は不要。ただし低すぎると小さな文字がどの向きでも読めず判定不能になるため1.5とする。
const DETECT_SCALE = 1.5;
// sourceLang未確定時に判定兼用OCRを試みる最大ページ数。これを超えたら中立(null)のまま本処理へ進む。
const PROBE_MAX_PAGES = 3;

// pdfjsのpage.render()は、ページの内容（CCITT/JBIG2等の圧縮フォーマットや解像度の組み合わせ）
// によっては、canvasやページ番号に関係なくPromiseが解決も拒否もされず無期限に応答しなくなる
// ことが実機で確認されている（本アプリのコードとは独立に、pdfjs-dist単体の再現テストで特定済み）。
// 1ページのこの種の不具合でドキュメント全体の処理が止まらないよう、明示的なタイムアウトで
// 打ち切り、失敗として次のページへ進めるようにする。
const RENDER_TIMEOUT_MS = 45_000;

// 高解像度（OCR_SCALE等）でページ全体をcanvasへ描画する。呼び出し側は使い終わったら
// canvas.width = canvas.height = 0 にしてピクセルバッファを解放すること（多ページで蓄積させない）。
//
// onCancelRegistered は、呼び出し元（effectのクリーンアップ等）が「この描画を今すぐ中断したい」
// ときに使うcancel関数を受け取るコールバック。React StrictMode（開発時）はeffectを一度
// 破棄→再実行するため、破棄された側のasync関数はawaitの続きが実行され続ける。もし
// renderPageToCanvasにこの仕組みが無いと、破棄されたはずの古い呼び出しと新しい呼び出しが
// 同じPDFPageProxyに対して同時にrender()し、pdfjs側が無応答になる（実機で再現・特定済み）。
// クリーンアップ時に即座にcancel()できるようにして、この競合を防ぐ。
async function renderPageToCanvas(
  page: PDFPageProxy,
  scale: number,
  // page.getViewportへ渡す絶対回転角（度）。undefinedならpdfjs既定（=page.rotate、
  // PDFの/Rotateメタデータ）。ページ内容自体が回転しているスキャンを正立させたい場合は
  // 呼び出し側が (page.rotate + 検出した補正量) % 360 を渡す。
  rotation: number | undefined,
  onCancelRegistered?: (cancel: () => void) => () => void
): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasコンテキストの取得に失敗しました");
  const renderTask = page.render({ canvas, canvasContext: ctx, viewport });
  const unregister = onCancelRegistered?.(() => renderTask.cancel());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      renderTask.promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          // pdfjs側が応答しなくなっているケースではcancel()自体も効かないことがあるが、
          // 効く場合に備えて一応呼んでおく。
          renderTask.cancel();
          reject(
            new Error(`ページの描画が${RENDER_TIMEOUT_MS / 1000}秒以内に完了しませんでした`)
          );
        }, RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    // 完了/失敗いずれの場合も、effectクリーンアップ側の中断対象リストから外す
    // （でないと完了済みタスクのcancel()参照がクリーンアップまで残り続ける）。
    unregister?.();
  }
  return canvas;
}

export default function PdfOverlayViewer({
  data,
  translations,
  showTranslation,
  zoom,
  onExtracted,
  sourceLang,
  onDetectedLang,
  onOcrConfidence,
  selectionMode,
  manualGroups,
  onManualRegion,
  dismissedIds,
  onRetranslate,
  onDismiss,
  processingEnabled,
  onPageProgress,
  refiningIds,
}: Props) {
  const pdfjsRef = useRef<typeof PdfjsNS | null>(null);
  // 効果（effect）・コールバック内部からの参照用。refなのでレンダー中には読まない
  // （JSXでページproxyを渡す先はpagesStateの方を使う。Reactのrefルール対応）。
  const pagesRef = useRef<PDFPageProxy[]>([]);
  // pagesRefと常に同じ中身を指す、レンダー（JSX）用のstate。
  const [pagesState, setPagesState] = useState<PDFPageProxy[]>([]);
  // OCR・テキスト抽出専用の、pagesRefとは別のドキュメントインスタンスのページ。
  // pdfjsは同一ページproxyに対する複数の同時render()呼び出しを想定しておらず、
  // 画面表示側（PdfPageViewの遅延描画・画面外での中断）とOCR側の高解像度描画が
  // 同じproxyを取り合うとrender()が解決しなくなる（実機で再現・特定済み）。
  // ドキュメントを2回読み込み、描画対象を完全に分離することで回避する。
  const ocrPagesRef = useRef<PDFPageProxy[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [pageViewportSizes, setPageViewportSizes] = useState<
    { width: number; height: number }[]
  >([]);
  // 回転補正前（page.rotateのみ反映した）の各ページの寸法。ensurePageRotationが
  // pageViewportSizesを回転後の寸法（90/270°では幅高が入れ替わる）で上書きするため、
  // 「回転していなければ本来この幅だった」という基準値を別途保持しておく。
  // 横長になったページを、この基準幅に収まるよう自動的に縮小表示するために使う
  // （render中に参照するためref ではなく state で持つ）。
  const [baseViewportSizes, setBaseViewportSizes] = useState<
    { width: number; height: number }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  // effect 1（ドキュメント読込）完了のたびにインクリメントし、effect 2b（処理ループ）を起動するトリガー。
  const [docToken, setDocToken] = useState(0);

  // ページ番号(1始まり) -> 抽出済みグループ／処理状態。
  const [pageGroups, setPageGroups] = useState<Record<number, LineGroup[]>>({});
  const [pageStatus, setPageStatus] = useState<Record<number, PdfPageStatus>>({});
  // 現在OCRを実行中のページ（あれば）。バナー表示に使う。
  const [activeOcr, setActiveOcr] = useState<{ pageIndex: number; phase: "probe" | "final" } | null>(
    null
  );

  // ページごとのテキスト層抽出結果キャッシュ。言語に依存しないため一度判定したら使い回す。
  // undefined=未判定、null=テキスト層なし（OCR対象と確定）、配列=テキスト層あり。
  const textLayerGroupsRef = useRef<Record<number, LineGroup[] | null | undefined>>({});
  // ページ番号(1始まり) -> 検出した回転補正量（度）。未検出のページはキーが存在しない。
  // sourceLang変更時の再処理（effect 2a）では消さない — 回転はスキャン画像自体の向きの
  // 問題であり原文言語には依存しないため、一度確定したら使い回してよい。
  // refを真実の源とし、stateは描画（PdfPageViewへの伝搬）専用に持つ
  // （pagesRef/pagesStateと同じパターン。effect 2bの依存に入れないための分離）。
  const pageRotationsRef = useRef<Record<number, PageRotation>>({});
  const [pageRotations, setPageRotations] = useState<Record<number, PageRotation>>({});
  // 処理（テキスト抽出/OCR）が完了したページ番号の集合。中断→再開でやり直さないために使う。
  const processedRef = useRef<Set<number>>(new Set());
  // sourceLang未確定のままPROBE_MAX_PAGES試して判定できなかった場合、以後は再判定を
  // 試みない（中断→再開のたびに無駄なprobe OCRをやり直さないため）。
  const probeExhaustedRef = useRef(false);

  // 手動領域OCR用の高解像度canvasキャッシュ。全ページぶん保持するとメモリを圧迫するため
  // 直近に触った1ページぶんだけ保持し、別ページを触ったら差し替える。
  const ocrCanvasCacheRef = useRef<{ pageIndex: number; canvas: HTMLCanvasElement } | null>(null);
  const manualIdRef = useRef(0);
  const [regionOcr, setRegionOcr] = useState<{ pageIndex: number } | null>(null);
  const [regionError, setRegionError] = useState<{ pageIndex: number; message: string } | null>(
    null
  );

  // effect 1: ドキュメント読込。dataが変わるたびに全ページのproxyとサイズだけ先に取得する
  // （getPage自体は軽い。実際のcanvas描画・テキスト抽出はページごとにeffect 2bで行う）。
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError(null);
      setNumPages(0);
      setPageViewportSizes([]);
      setBaseViewportSizes([]);
      setPageGroups({});
      setPageStatus({});
      setActiveOcr(null);
      onOcrConfidence?.(null);
      pagesRef.current = [];
      setPagesState([]);
      ocrPagesRef.current = [];
      textLayerGroupsRef.current = {};
      pageRotationsRef.current = {};
      setPageRotations({});
      processedRef.current = new Set();
      probeExhaustedRef.current = false;
      if (ocrCanvasCacheRef.current) {
        ocrCanvasCacheRef.current.canvas.width = 0;
        ocrCanvasCacheRef.current.canvas.height = 0;
        ocrCanvasCacheRef.current = null;
      }
      manualIdRef.current = 0;

      try {
        const pdfjs = await loadPdfjs();
        pdfjsRef.current = pdfjs;
        const docOptions = {
          cMapUrl: "/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/standard_fonts/",
          // JBIG2/JPX/ICC のデコードに使うwasm。未指定だとスキャンPDFでJbig2Errorが発生し、
          // 画像マスクが丸ごと破棄されてcanvasに何も描画されない（末尾スラッシュ必須）。
          wasmUrl: "/wasm/",
        };
        // getDocument は渡した ArrayBuffer を detach/transfer することがあるため複製して渡す。
        // 画面表示用とOCR用で完全に独立した2つのドキュメントインスタンスを読み込む
        // （ocrPagesRef宣言部のコメント参照。render()の同時呼び出し衝突を避けるため）。
        const [doc, ocrDoc] = await Promise.all([
          pdfjs.getDocument({ ...docOptions, data: data.slice(0) }).promise,
          pdfjs.getDocument({ ...docOptions, data: data.slice(0) }).promise,
        ]);
        if (cancelled) return;

        const pages: PDFPageProxy[] = [];
        const ocrPages: PDFPageProxy[] = [];
        const sizes: { width: number; height: number }[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const [page, ocrPage] = await Promise.all([doc.getPage(n), ocrDoc.getPage(n)]);
          if (cancelled) return;
          pages.push(page);
          ocrPages.push(ocrPage);
          const vp = page.getViewport({ scale: SCALE });
          sizes.push({ width: vp.width, height: vp.height });
        }
        if (cancelled) return;

        setBaseViewportSizes(sizes);
        pagesRef.current = pages;
        setPagesState(pages);
        ocrPagesRef.current = ocrPages;
        setPageViewportSizes(sizes);
        setNumPages(doc.numPages);
        setDocToken((t) => t + 1);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [data, onOcrConfidence]);

  // effect 2a: sourceLangが変化したら、OCR依存（テキスト層なし）で処理済みのページだけを
  // 再処理対象に戻す。テキスト層があるページは言語に依存しないため触らない。
  useEffect(() => {
    const ocrPageIndexes = Object.entries(textLayerGroupsRef.current)
      .filter(([, v]) => v === null)
      .map(([k]) => Number(k));
    if (ocrPageIndexes.length === 0) return;

    let changed = false;
    for (const n of ocrPageIndexes) {
      if (processedRef.current.delete(n)) changed = true;
    }
    if (!changed) return;

    setPageGroups((prev) => {
      const next = { ...prev };
      for (const n of ocrPageIndexes) delete next[n];
      return next;
    });
    setPageStatus((prev) => {
      const next = { ...prev };
      for (const n of ocrPageIndexes) next[n] = "pending";
      return next;
    });
  }, [sourceLang]);

  // effect 2b: ページ順次処理ループ。1ページ目から順にテキスト抽出/OCRを行い、
  // 終わったページから親へ通知する。processingEnabled=falseの間は新規開始しない（中断）。
  useEffect(() => {
    if (docToken === 0) return;
    if (!processingEnabled) return;
    let cancelled = false;
    // このeffectインスタンスが今まさに開始した描画のcancel関数を集めておく。
    // React StrictMode（開発時）はeffectを一度破棄→再実行するため、cleanup時に
    // ここへ集めたcancel()を即座に呼ばないと、破棄後もawaitの続きが動き続け、
    // 新しいeffectインスタンスと同じPDFPageProxyへ同時にrender()してしまう
    // （pdfjs側が無応答になる不具合を実機で確認済み）。
    const pendingRenderCancels = new Set<() => void>();
    function registerRenderCancel(cancel: () => void): () => void {
      if (cancelled) {
        cancel();
        return () => {};
      }
      pendingRenderCancels.add(cancel);
      return () => pendingRenderCancels.delete(cancel);
    }

    // このページのOCR用回転補正量を確定する（未検出なら低解像度OCRで検出しキャッシュする）。
    // テキスト層があるページはOCRしないため呼び出し元で除外している。誤った向きのページでは
    // 言語判定も崩れるため、probePage/processPageの本OCRより必ず先に呼ぶこと。
    async function ensurePageRotation(n: number, page: PDFPageProxy): Promise<PageRotation> {
      const cached = pageRotationsRef.current[n];
      if (cached !== undefined) return cached;

      // rotation未指定 = pdfjs既定（page.rotate、PDFの/Rotateメタデータ）で描画。
      const canvas = await renderPageToCanvas(page, DETECT_SCALE, undefined, registerRenderCancel);
      let rotation: PageRotation;
      try {
        rotation = await detectPageRotation(canvas, sourceLang);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }

      pageRotationsRef.current[n] = rotation;
      setPageRotations((prev) => ({ ...prev, [n]: rotation }));

      if (rotation !== 0) {
        // 90/270°では幅と高さが入れ替わる。手動swapはミスを生みやすいので、
        // pdfjsのviewportから正しい向きの寸法を取り直す。
        const vp = page.getViewport({ scale: SCALE, rotation: (page.rotate + rotation) % 360 });
        setPageViewportSizes((prev) => {
          const next = [...prev];
          next[n - 1] = { width: vp.width, height: vp.height };
          return next;
        });
      }

      return rotation;
    }

    // 判定兼用OCR（sourceLang未確定時のprobeフェーズ専用）。結果は公開せず、
    // 検出できた言語だけを返す（捨てる予定のこの結果は翻訳へ回さない＝LLM呼び出しの二重化を防ぐ）。
    async function probePage(n: number): Promise<SourceLang | null> {
      // OCR専用ドキュメントのページを使う（画面表示用のpagesRefとは描画を分離する）。
      const page = ocrPagesRef.current[n - 1];
      if (textLayerGroupsRef.current[n] === undefined) {
        const viewport = page.getViewport({ scale: SCALE });
        const textContent = await page.getTextContent();
        const extracted = groupTextItems(pdfjsRef.current!, textContent.items, viewport, n);
        textLayerGroupsRef.current[n] = extracted.length > 0 ? extracted : null;
      }
      const textGroups = textLayerGroupsRef.current[n];
      if (textGroups) {
        const sample = textGroups
          .filter((g) => g.translatable)
          .map((g) => g.text)
          .join(" ");
        return detectSourceLang(sample);
      }

      setActiveOcr({ pageIndex: n, phase: "probe" });
      try {
        const rotation = await ensurePageRotation(n, page);
        const canvas = await renderPageToCanvas(
          page,
          OCR_SCALE,
          (page.rotate + rotation) % 360,
          registerRenderCancel
        );
        const result = await runOcr(canvas, SCALE / OCR_SCALE, null, n);
        canvas.width = 0;
        canvas.height = 0;
        return result.detected;
      } finally {
        setActiveOcr((prev) => (prev?.pageIndex === n ? null : prev));
      }
    }

    // 1ページぶんの本処理（テキスト層抽出 or OCR）。結果をpageGroupsへ格納し、
    // 親へonExtractedで通知して翻訳を開始させる。
    async function processPage(n: number): Promise<void> {
      setPageStatus((prev) => ({ ...prev, [n]: "processing" }));
      // OCR専用ドキュメントのページを使う（画面表示用のpagesRefとは描画を分離する）。
      const page = ocrPagesRef.current[n - 1];

      let cached = textLayerGroupsRef.current[n];
      if (cached === undefined) {
        const viewport = page.getViewport({ scale: SCALE });
        const textContent = await page.getTextContent();
        const extracted = groupTextItems(pdfjsRef.current!, textContent.items, viewport, n);
        cached = extracted.length > 0 ? extracted : null;
        textLayerGroupsRef.current[n] = cached;
      }

      if (cached) {
        // テキスト層がある。OCRは不要。
        setPageGroups((prev) => ({ ...prev, [n]: cached }));
        onExtracted(n, cached);
        const sample = cached
          .filter((g) => g.translatable)
          .map((g) => g.text)
          .join(" ");
        const detected = detectSourceLang(sample);
        if (detected && sourceLang === null) onDetectedLang(detected);
        setPageStatus((prev) => ({ ...prev, [n]: "done" }));
        return;
      }

      // テキスト層が存在しない（スキャン/画像ベースの）ページ。OCRする。
      setActiveOcr({ pageIndex: n, phase: sourceLang === null ? "probe" : "final" });
      try {
        const rotation = await ensurePageRotation(n, page);
        const canvas = await renderPageToCanvas(
          page,
          OCR_SCALE,
          (page.rotate + rotation) % 360,
          registerRenderCancel
        );
        const result = await runOcr(canvas, SCALE / OCR_SCALE, sourceLang, n);
        canvas.width = 0;
        canvas.height = 0;

        setPageGroups((prev) => ({ ...prev, [n]: result.groups }));
        onExtracted(n, result.groups);
        if (result.detected && sourceLang === null) onDetectedLang(result.detected);
        onOcrConfidence?.(result.confidence);
        setPageStatus((prev) => ({ ...prev, [n]: "done" }));
      } finally {
        setActiveOcr((prev) => (prev?.pageIndex === n ? null : prev));
      }
    }

    async function run() {
      const total = pagesRef.current.length;
      if (total === 0) return;
      onPageProgress?.(processedRef.current.size, total);

      if (sourceLang === null && !probeExhaustedRef.current) {
        const probeLimit = Math.min(PROBE_MAX_PAGES, total);
        for (let n = 1; n <= probeLimit; n++) {
          if (cancelled) return;
          let detected: SourceLang | null = null;
          try {
            detected = await probePage(n);
          } catch (e) {
            // このページの判定は失敗として次の候補ページへ進む（判定兼用OCRなので
            // 失敗しても本処理には影響しない）。cancelled後（effect破棄後）に
            // 解決した古い呼び出しの場合はもうこのインスタンスの仕事ではないため何もしない。
            if (!cancelled) console.error(`ページ${n}の言語判定に失敗しました:`, e);
          }
          if (cancelled) return;
          if (detected) {
            onDetectedLang(detected);
            return; // sourceLang確定によりこのeffectが再実行される
          }
        }
        probeExhaustedRef.current = true;
      }

      for (let n = 1; n <= total; n++) {
        if (cancelled) return;
        if (processedRef.current.has(n)) continue;
        try {
          await processPage(n);
        } catch (e) {
          // 1ページの抽出/OCR失敗でドキュメント全体の処理を止めない。
          // このページはあきらめて「処理失敗」表示のまま次のページへ進む。cancelled後
          // （effect破棄後）に解決した古い呼び出しの場合はもうこのインスタンスの仕事ではない。
          if (!cancelled) {
            console.error(`ページ${n}の処理に失敗しました:`, e);
            setPageStatus((prev) => ({ ...prev, [n]: "error" }));
            setActiveOcr((prev) => (prev?.pageIndex === n ? null : prev));
          }
        }
        if (cancelled) return;
        processedRef.current.add(n);
        onPageProgress?.(processedRef.current.size, total);
      }
    }

    run();
    return () => {
      cancelled = true;
      // 進行中の描画があれば即座に中断する。放置すると、React StrictMode
      // （開発時のeffect二重実行）や中断→再開等でこのeffectが破棄された後も
      // render()が完了するまでawaitの続きが動き続け、新しいeffectインスタンスの
      // render()と同じPDFPageProxyを取り合って無応答になる（実機で再現・特定済み）。
      for (const cancel of pendingRenderCancels) cancel();
      pendingRenderCancels.clear();
    };
  }, [
    docToken,
    sourceLang,
    processingEnabled,
    onExtracted,
    onDetectedLang,
    onOcrConfidence,
    onPageProgress,
  ]);

  // 「文字を検出できませんでした」等の一時メッセージは数秒で自動的に消す。
  useEffect(() => {
    if (!regionError) return;
    const t = setTimeout(() => setRegionError(null), 3500);
    return () => clearTimeout(t);
  }, [regionError]);

  // 手動指定領域のOCR。ページ単位で高解像度canvasを直近1枚だけキャッシュして使い回す。
  const handleManualSelection = useCallback(
    async (pageIndex: number, sel: Box) => {
      // OCR専用ドキュメントのページを使う（画面表示用のpagesRefとは描画を分離する）。
      const page = ocrPagesRef.current[pageIndex - 1];
      if (!page) return;
      setRegionError(null);
      setRegionOcr({ pageIndex });
      try {
        const cache = ocrCanvasCacheRef.current;
        let full: HTMLCanvasElement;
        if (cache && cache.pageIndex === pageIndex) {
          full = cache.canvas;
        } else {
          if (cache) {
            cache.canvas.width = 0;
            cache.canvas.height = 0;
          }
          // ユーザーはpageViewportSizes基準の正立表示上で範囲を選んでいるため、
          // 自動OCRと同じ検出済み回転（未検出＝テキスト層ページ等なら0）で描画する。
          const rotation = pageRotationsRef.current[pageIndex] ?? 0;
          full = await renderPageToCanvas(page, OCR_SCALE, (page.rotate + rotation) % 360);
          ocrCanvasCacheRef.current = { pageIndex, canvas: full };
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

        const id = `p${pageIndex}-manual-${manualIdRef.current++}`;
        const group = await runOcrRegion(
          crop,
          SCALE / OCR_SCALE,
          { left: sel.left, top: sel.top },
          id,
          sourceLang,
          pageIndex
        );
        if (group) {
          onManualRegion(group);
        } else {
          setRegionError({
            pageIndex,
            message: "この範囲から翻訳できる文字を検出できませんでした",
          });
        }
      } catch (e) {
        setRegionError({
          pageIndex,
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setRegionOcr(null);
      }
    },
    [sourceLang, onManualRegion]
  );

  if (error) {
    return (
      <div className="flex h-64 w-full max-w-3xl items-center justify-center rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/30">
        PDFの表示に失敗しました: {error}
      </div>
    );
  }

  if (numPages === 0) {
    return (
      <div className="flex h-64 w-full max-w-3xl items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        PDFを解析しています…
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-10 pt-6">
      {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
        // ensurePageRotationが検出した補正量（PDFの/Rotateとは別物）を絶対角に変換して渡す。
        // 未検出または0°ならundefined（PdfPageView側もpdfjs既定=page.rotateで描画する）。
        const rotationDelta = pageRotations[n];
        const rotation =
          rotationDelta !== undefined && rotationDelta !== 0
            ? ((pagesState[n - 1]?.rotate ?? 0) + rotationDelta) % 360
            : undefined;
        // 90/270°補正で幅と高さが入れ替わり、他ページより横幅が広くなって画面から
        // はみ出すことがある。90/270°補正が入っていなければこの本来の幅と現在の幅は
        // 一致するため、fitScaleは常に1になり無害（180°補正や未回転ページには影響しない）。
        const currentSize = pageViewportSizes[n - 1] ?? { width: 0, height: 0 };
        const baseWidth = baseViewportSizes[n - 1]?.width ?? currentSize.width;
        const fitScale =
          currentSize.width > 0 ? Math.min(1, baseWidth / currentSize.width) : 1;
        return (
          <PdfPageView
            key={n}
            page={pagesState[n - 1] as unknown as RenderablePage}
            pageIndex={n}
            pageCount={numPages}
            scale={SCALE}
            rotation={rotation}
            rotationCorrected={!!rotationDelta}
            viewportSize={currentSize}
            zoom={zoom * fitScale}
            groups={pageGroups[n] ?? []}
            manualGroups={manualGroups}
            translations={translations}
            showTranslation={showTranslation}
            dismissedIds={dismissedIds}
            onRetranslate={onRetranslate}
            onDismiss={onDismiss}
            selectionMode={selectionMode}
            onManualSelection={handleManualSelection}
            status={pageStatus[n] ?? "pending"}
            ocrPhase={activeOcr?.pageIndex === n ? activeOcr.phase : undefined}
            regionOcrRunning={regionOcr?.pageIndex === n}
            regionError={regionError?.pageIndex === n ? regionError.message : null}
            refiningIds={refiningIds}
          />
        );
      })}
    </div>
  );
}
