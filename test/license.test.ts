import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// ライセンスは GPL-3.0（持ち主の決定、2026-10-19）。LICENSE の全文が、うっかり書き換わっていないことを確かめる。
const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// 2026-10-19 に LICENSE へ置いた全文（Debian の common-licenses/GPL-3 と一致。674 行、35149 バイト）の SHA-256。
// 全文を意図して差し替えるとき（GPL-3.0 の版を替える、など）だけ、この値を更新する。
const GPL3_SHA256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";

describe("ライセンス", () => {
  it("LICENSE は GPL-3.0 の全文で、書き換わっていない", async () => {
    const text = await read("../LICENSE");
    assert.equal(createHash("sha256").update(text).digest("hex"), GPL3_SHA256);
  });

  it("LICENSE は、GPL-3.0 の見出しと、第 0〜17 条、末尾の「適用のしかた」を含む（ハッシュが合わないときに、何が欠けたか分かるように）", async () => {
    const text = await read("../LICENSE");
    assert.match(text, /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
    for (let n = 0; n <= 17; n += 1) assert.match(text, new RegExp(`^\\s*${n}\\. [A-Z]`, "m"), `第 ${n} 条がありません`);
    assert.match(text, /END OF TERMS AND CONDITIONS/);
    assert.match(text, /How to Apply These Terms to Your New Programs/);
  });

  it("package.json と package-lock.json の license は GPL-3.0-only", async () => {
    const pkg = JSON.parse(await read("../package.json")) as { license?: string };
    const lock = JSON.parse(await read("../package-lock.json")) as { packages: Record<string, { license?: string }> };
    assert.equal(pkg.license, "GPL-3.0-only");
    assert.equal(lock.packages[""]?.license, "GPL-3.0-only");
  });

  it("README が、GPL-3.0 と LICENSE への案内を載せている", async () => {
    const readme = await read("../README.md");
    assert.match(readme, /GPL-3\.0/);
    assert.match(readme, /\]\(\.\/LICENSE\)/);
  });
});
