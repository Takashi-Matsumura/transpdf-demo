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
  /** このグループが属するPDFページ番号（1始まり）。複数ページPDFでのid名前空間分離・表示制御に使う。 */
  pageIndex: number;
};

/**
 * 原文（翻訳元）の言語。OCRに使うtraineddataの組み合わせと、
 * 翻訳プロンプトの言語指定の両方をこのキーで引く。
 */
export type SourceLang = "vie" | "eng" | "mya";

/**
 * スキャン画像の中身自体が回転しているページを正立させるための補正量（度、時計回り）。
 * PDFの/Rotateメタデータ（pdfjsが暗黙に適用する）とは別物で、こちらはOCRの
 * 認識結果から推定する。0=補正不要。
 */
export type PageRotation = 0 | 90 | 180 | 270;

/** オーバーレイに表示する1グループぶんの翻訳結果。 */
export type TranslationEntry = {
  text: string;
  /** リトライしても翻訳できず、原文にフォールバックした場合true */
  failed: boolean;
  /**
   * 「文脈を踏まえて全体を再翻訳」（パス2の文脈適応翻訳）で更新された結果ならtrue。
   * オーバーレイ側で、旧訳（previousText）との文字差分がある箇所だけ赤字表示する。
   */
  refined?: boolean;
  /**
   * refined:true のとき、更新される直前（パス1時点）の訳文。
   * これと現在の text を文字単位で比較し、実際に変わった部分だけを赤字にするために使う。
   */
  previousText?: string;
};

/**
 * 文書全体を俯瞰したうえでの推定結果（パス2「文脈適応翻訳」で使用）。
 * パス1で得た単語単位の訳をLLMに見渡させ、文書の種類・分野を推定させたもの。
 */
export type DocumentAnalysis = {
  /** 文書の種類・分野についての1〜2文の要約（例: "ベトナムの銀行が発行した法人口座の取引明細書"）。 */
  summary: string;
  /** 翻訳プロンプトのルーティングに使う分野キー。MoEモデルの専門家選択を促す目的でプロンプト先頭に埋め込む。 */
  expert: ExpertKey;
};

/**
 * 翻訳プロンプトの先頭に付与する分野ヒント。
 * MoEモデル（複数の専門家ネットワークを持つLLM）は、プロンプトに分野を
 * 明示するとその分野に強い専門家が選ばれやすくなる。denseモデルでも
 * 文脈が翻訳精度を底上げする効果は同様に期待できる。
 */
export type ExpertKey =
  | "finance"
  | "legal"
  | "medical"
  | "technical"
  | "general";
