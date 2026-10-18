/**
 * net-smoke（実ブラウザ上のゲストでコマンドを実行する検査）で、1 ステップの結果が期待どおりかを判定する。
 * 外れたときの重さは level で決める:
 *   "error" … CI を失敗にする（外部に依存しない、確実に通るべきもの）
 *   "warn"  … 警告として残すだけ（インターネット上のサーバーなど、WasmBox の外の事情で落ちうるもの）
 */

export type Level = "error" | "warn";

export interface StepExpectation {
  /** 出力がこれに一致すること。省略すると、終了コード 0 だけを見る */
  match?: RegExp;
  /** 既定は "error" */
  level?: Level;
}

export interface StepVerdict {
  level: Level;
  reason: string;
}

const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 160) + "…" : flat;
};

/** 期待どおりなら undefined、外れたら理由つきの判定を返す */
export function judgeStep(result: { rc: number | string; out: string }, expectation: StepExpectation): StepVerdict | undefined {
  const level = expectation.level ?? "error";
  if (result.rc === "timeout") return { level, reason: "時間切れ" };
  if (result.rc === "skipped") return { level, reason: "実行されなかった（全体の時間切れ）" };
  if (result.rc !== 0) return { level, reason: `終了コードが ${String(result.rc)}（出力: ${snippet(result.out)}）` };
  if (expectation.match && !expectation.match.test(result.out)) {
    return { level, reason: `出力が期待と違う（期待: ${String(expectation.match)}、実際: ${snippet(result.out)}）` };
  }
  return undefined;
}
