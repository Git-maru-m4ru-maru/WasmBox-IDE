import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// ライセンスは GPL-3.0 の「以降のバージョンも許す」形（or-later。持ち主の決定、2026-10-19）。LICENSE の全文が、うっかり書き換わっていないことを確かめる。
const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// 2026-10-19 に LICENSE へ置いた全文（Debian の common-licenses/GPL-3 と一致。674 行、35149 バイト）の SHA-256。
// 全文を意図して差し替えるとき（GPL-3.0 の版を替える、など）だけ、この値を更新する。
// 標準の許諾文の「以降のバージョンも」の部分（行の折り返しがあるので、空白は何文字でもよい）
const ANY_LATER = /either version 3 of the License, or\s+\(at your option\) any later version/;

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

  it("package.json と package-lock.json の license は GPL-3.0-or-later", async () => {
    const pkg = JSON.parse(await read("../package.json")) as { license?: string };
    const lock = JSON.parse(await read("../package-lock.json")) as { packages: Record<string, { license?: string }> };
    assert.equal(pkg.license, "GPL-3.0-or-later");
    assert.equal(lock.packages[""]?.license, "GPL-3.0-or-later");
  });

  it("README が、GPL-3.0 と LICENSE への案内と、「以降のバージョンも許す」ことを載せている", async () => {
    const readme = await read("../README.md");
    assert.match(readme, /GPL-3\.0/);
    assert.match(readme, /\]\(\.\/LICENSE\)/);
    // or-later の意思は、著作権表示を入れない代わりに、README の標準の許諾文で示す
    assert.match(readme, ANY_LATER);
  });

  it("README の許諾文は、LICENSE の末尾にある GPL-3.0 の標準の文面と一致する（言い回しを変えていない）", async () => {
    const license = await read("../LICENSE");
    const readme = await read("../README.md");
    assert.match(license, ANY_LATER);
    assert.match(readme, ANY_LATER);
    // 標準の文面は、LICENSE の中で行の途中で折り返されている。空白をそろえて、段落ごと一致することを確かめる
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const paragraph = "This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.";
    assert.ok(flat(license).includes(paragraph), "LICENSE に標準の文面がありません");
    assert.ok(flat(readme).includes(paragraph), "README の許諾文が、標準の文面と違います");
  });
});
