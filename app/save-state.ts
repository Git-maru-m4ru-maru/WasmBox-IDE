import type { StoreStats } from "../src/storage/index.ts";

/**
 * 画面に出す「書き込みの保存状態」。
 * - saved: 発行済みの書き込みは、すべて IndexedDB に保存済み
 * - pending: 保存待ちの書き込みがある（通常は 1 秒以内に saved になる）
 * - error: 直近の保存に失敗していて、まだ保存できていない（再試行は続く）
 */
export type SaveState = "saved" | "pending" | "error";

type SaveStats = Pick<StoreStats, "pendingBytes" | "flushes" | "flushErrors">;

/**
 * ストアの統計から、保存状態を決める。
 *
 * `flushes` は成功回数、`flushErrors` は失敗回数で、どちらも増える一方の数。
 * 「最後に成功した時点より後に失敗が増えている」間だけ error にする。
 * 失敗のあと再試行が成功すれば、自然に saved へ戻る。
 */
export class SaveStateTracker {
  #flushes = 0;
  #errorsAtLastSuccess = 0;

  update(stats: SaveStats): SaveState {
    if (stats.flushes !== this.#flushes) {
      this.#flushes = stats.flushes;
      this.#errorsAtLastSuccess = stats.flushErrors;
    }
    if (stats.pendingBytes > 0) {
      return stats.flushErrors > this.#errorsAtLastSuccess ? "error" : "pending";
    }
    return "saved";
  }
}

export const SAVE_STATE_LABEL: Record<SaveState, string> = {
  saved: "保存済み",
  pending: "保存しています…",
  error: "保存に失敗（再試行中）",
};
