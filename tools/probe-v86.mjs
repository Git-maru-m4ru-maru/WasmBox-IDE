// 一時的なプローブ: npm の v86 パッケージ（CI で入れた版）に、ネットワーク関連の設定が実在するかを確かめる。
// 結果は GitHub Actions の annotation に出す。確認が済んだら、このファイルと probe.yml は消す。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { notice } from "./smoke-lib.mjs";

const root = "node_modules/v86";
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
notice("probe v86 package", {
  name: pkg.name,
  version: pkg.version,
  main: pkg.main,
  module: pkg.module,
  files: pkg.files,
  top: readdirSync(root),
  build: readdirSync(`${root}/build`).map((name) => `${name}:${statSync(`${root}/build/${name}`).size}`),
  docs: existsSync(`${root}/docs`) ? readdirSync(`${root}/docs`) : null,
  src: existsSync(`${root}/src`) ? readdirSync(`${root}/src`).filter((n) => /net|wisp|fetch|ne2k|virtio/i.test(n)) : null,
});

// 読みやすさのため、デバッグ版があればそちらを見る
const candidates = ["libv86-debug.js", "libv86.js"].filter((name) => existsSync(`${root}/build/${name}`));
const file = candidates[0];
const js = readFileSync(`${root}/build/${file}`, "utf8");
const counts = {};
for (const key of ["relay_url", "network_relay_url", "net_device", "wisp", "cors_proxy", "dns_method", "inbrowser", "fetch", "virtio", "ne2k", "wsproxy", "WebSocket"]) {
  counts[key] = js.split(key).length - 1;
}
notice("probe v86 counts", { file, bytes: js.length, counts });

function around(key, before, after, max) {
  const snippets = [];
  let from = 0;
  while (snippets.length < max) {
    const at = js.indexOf(key, from);
    if (at < 0) break;
    snippets.push(js.slice(Math.max(0, at - before), at + after).replace(/\s+/g, " "));
    from = at + key.length + 400;
  }
  return snippets;
}
notice("probe v86 relay_url", around("relay_url", 500, 900, 3));
notice("probe v86 net_device", around("net_device", 300, 700, 2));
notice("probe v86 wisp", around("wisp://", 400, 600, 2));
notice("probe v86 fetch", around("cors_proxy", 400, 600, 2));

if (existsSync(`${root}/docs/networking.md`)) {
  notice("probe v86 networking.md", readFileSync(`${root}/docs/networking.md`, "utf8").slice(0, 9000));
}
