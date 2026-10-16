/**
 * 公開用のサイト（site/）を組み立てる。アプリ本体（app.js）は、このあと esbuild が site/app.js に出力する
 * （`npm run site:build` が両方を続けて実行する）。
 *
 * 前提（なければ、足りないものを一覧して終了する）:
 *   - poc/vendor/  … tools/prepare-vendor.sh が用意する v86・カーネル・xterm.js
 *   - poc/image/   … bash image/build.sh が作る manifest.json・chunks/・initrd.cpio
 *
 *   node tools/build-site.ts
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const SITE = "site";

/** [コピー元, site/ の中での配置先] */
const FILES: readonly (readonly [string, string])[] = [
  ["app/index.html", "index.html"],
  ["poc/vendor/libv86.js", "vendor/libv86.js"],
  ["poc/vendor/v86.wasm", "vendor/v86.wasm"],
  ["poc/vendor/seabios.bin", "vendor/seabios.bin"],
  ["poc/vendor/vgabios.bin", "vendor/vgabios.bin"],
  ["poc/vendor/buildroot-bzimage.bin", "vendor/kernel.bin"],
  ["poc/vendor/xterm.js", "vendor/xterm.js"],
  ["poc/vendor/xterm.css", "vendor/xterm.css"],
  ["poc/image/manifest.json", "image/manifest.json"],
  ["poc/image/initrd.cpio", "image/initrd.cpio"],
];
const IMAGE_CHUNKS = "poc/image/chunks";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

const required = [...FILES.map(([from]) => from), IMAGE_CHUNKS];
const missing: string[] = [];
for (const path of required) if (!(await exists(path))) missing.push(path);
if (missing.length > 0) {
  console.error("サイトに必要なファイルが足りません:\n" + missing.map((path) => "  - " + path).join("\n"));
  console.error("\nvendor は bash tools/prepare-vendor.sh、イメージは bash image/build.sh で用意してください。");
  process.exit(1);
}

await rm(SITE, { recursive: true, force: true });
await mkdir(SITE, { recursive: true });
for (const [from, to] of FILES) {
  await mkdir(join(SITE, to, ".."), { recursive: true });
  await cp(from, join(SITE, to));
}
// chunks/ は、中身（ハッシュ名のファイル）だけをコピーする。build.sh が置く `.gitignore` は含めない
await cp(IMAGE_CHUNKS, join(SITE, "image/chunks"), { recursive: true, filter: (source) => basename(source) !== ".gitignore" });

const chunks = (await readdir(join(SITE, "image/chunks"))).length;
const bytes = await directorySize(SITE);
console.log(`site/ を作りました（${(bytes / 1024 / 1024).toFixed(1)} MiB、チャンク ${chunks} 個）。続けて app.js を出力します。`);
