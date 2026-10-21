import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeStep } from "../tools/step-judge.ts";

describe("judgeStep", () => {
  it("終了コード 0 で、出力が期待に合えば、問題なし", () => {
    assert.equal(judgeStep({ rc: 0, out: "8388608" }, { match: /^8388608$/ }), undefined);
    assert.equal(judgeStep({ rc: 0, out: "何でもよい" }, {}), undefined);
  });

  it("終了コードが 0 でなければ外れ。出力の一部を理由に含める", () => {
    const verdict = judgeStep({ rc: 1, out: "wget: bad address" }, {});
    assert.equal(verdict?.level, "error");
    assert.match(verdict?.reason ?? "", /終了コードが 1.*bad address/);
  });

  it("時間切れと、実行されなかったステップは、外れ（期待の出力に一致していても）", () => {
    assert.match(judgeStep({ rc: "timeout", out: "hello" }, { match: /hello/ })?.reason ?? "", /時間切れ/);
    assert.match(judgeStep({ rc: "skipped", out: "" }, {})?.reason ?? "", /実行されなかった/);
  });

  it("出力が期待に合わなければ外れ。期待と実際を理由に含める", () => {
    const verdict = judgeStep({ rc: 0, out: "404 Not Found" }, { match: /^hello$/ });
    assert.match(verdict?.reason ?? "", /期待: \/\^hello\$\/.*404 Not Found/);
  });

  it("level の既定は error。warn を指定すると warn になる", () => {
    assert.equal(judgeStep({ rc: 1, out: "" }, {})?.level, "error");
    assert.equal(judgeStep({ rc: 1, out: "" }, { level: "warn" })?.level, "warn");
    assert.equal(judgeStep({ rc: 0, out: "x" }, { match: /y/, level: "warn" })?.level, "warn");
  });

  it("長い出力は、理由の中で切り詰める", () => {
    const verdict = judgeStep({ rc: 2, out: "あ".repeat(1000) }, {});
    assert.ok((verdict?.reason.length ?? 0) < 260);
  });
});
