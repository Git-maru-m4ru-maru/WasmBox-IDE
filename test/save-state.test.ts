import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SaveStateTracker } from "../app/save-state.ts";

const stats = (pendingBytes: number, flushes: number, flushErrors: number) => ({ pendingBytes, flushes, flushErrors });

describe("SaveStateTracker", () => {
  it("未保存がなければ saved、あれば pending", () => {
    const tracker = new SaveStateTracker();
    assert.equal(tracker.update(stats(0, 0, 0)), "saved");
    assert.equal(tracker.update(stats(4096, 0, 0)), "pending");
    assert.equal(tracker.update(stats(0, 1, 0)), "saved");
  });

  it("保存に失敗して、まだ保存できていない間は error", () => {
    const tracker = new SaveStateTracker();
    assert.equal(tracker.update(stats(4096, 0, 0)), "pending");
    assert.equal(tracker.update(stats(4096, 0, 1)), "error");
    assert.equal(tracker.update(stats(4096, 0, 1)), "error", "再試行の前は error のまま");
    assert.equal(tracker.update(stats(4096, 0, 2)), "error");
  });

  it("失敗のあと再試行が成功したら、error をやめて saved に戻る", () => {
    const tracker = new SaveStateTracker();
    assert.equal(tracker.update(stats(4096, 0, 1)), "error");
    assert.equal(tracker.update(stats(0, 1, 1)), "saved");
    assert.equal(tracker.update(stats(8192, 1, 1)), "pending", "過去の失敗は、新しい書き込みの状態に影響しない");
  });

  it("成功のあとの新しい失敗は、また error になる", () => {
    const tracker = new SaveStateTracker();
    assert.equal(tracker.update(stats(0, 3, 1)), "saved");
    assert.equal(tracker.update(stats(4096, 3, 2)), "error");
  });

  it("書き込みがなければ、失敗の履歴があっても saved", () => {
    const tracker = new SaveStateTracker();
    assert.equal(tracker.update(stats(0, 0, 5)), "saved");
  });
});
