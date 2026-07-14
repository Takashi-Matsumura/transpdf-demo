// PDFオーバーレイ翻訳ビューアで使う共有型。

/** キャンバス座標系（CSS px, 左上原点, y下向き）でのボックス。 */
export type Box = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** ラジアン。水平テキストなら0。 */
  angle: number;
};

/** ページから抽出した「行/セル」単位のテキストグループ。翻訳の入出力単位。 */
export type LineGroup = {
  id: string;
  text: string;
  box: Box;
  /** 数字・記号のみなど、翻訳不要と判定したグループ */
  translatable: boolean;
};

export type TranslateRequestBody = {
  texts: string[];
};

export type TranslateResponseBody = {
  translations: string[];
  /** 同じ長さの配列。true の要素はローカルLLMから応答が得られず原文にフォールバックした */
  failed: boolean[];
};

/** オーバーレイに表示する1グループぶんの翻訳結果。 */
export type TranslationEntry = {
  text: string;
  /** リトライしても翻訳できず、原文にフォールバックした場合true */
  failed: boolean;
};
