# WasmBox

ブラウザ内で動く、WASM上の仮想Linux環境。設計は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

v86（x86 エミュレータ）の上で Alpine Linux（Node.js・Python 入り）が動き、ディスクは IndexedDB に永続化される。
xterm.js のターミナルページ（`app/`）から使える。**M1〜M5 とターミナルアプリは実ブラウザで確認済み**（確認の内容と、確認していないことは「検証状況」を参照）。
進み具合は ARCHITECTURE.md の 9 章。**公開サイトはまだ作っていない**（GitHub Pages の有効化とライセンスの確認は、リポジトリの持ち主の判断。[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）。
AI エージェントや共同開発者向けのルールは [AGENTS.md](./AGENTS.md)。

## セットアップ

```sh
npm install
npm test          # テスト実行
npm run typecheck # 型チェック
```

Node.js 22.18 以上が必要。TypeScript をそのまま実行するので、ビルド手順はない。

ブラウザで Alpine を起動するには、Docker でイメージを作り、v86 の一式を `poc/vendor/` に置く。
手順は [image/README.md](./image/README.md) と [poc/README.md](./poc/README.md)。

### ターミナルアプリ（`site/`）を作って開く

```sh
npm install
npm install --no-save --package-lock=false v86@0.5 @xterm/xterm@5.5.0   # v86 と xterm.js の実体（コミットしない）
bash image/build.sh          # Docker が必要。poc/image/ にディスクイメージができる
bash tools/prepare-vendor.sh # poc/vendor/ に v86・BIOS・カーネル・xterm.js を置く
npm run site:build           # site/ を組み立てる
npm run site:serve           # http://127.0.0.1:8080/ を開く
```

CI（`.github/workflows/site.yml`）が、同じ手順でビルドして実ブラウザで確かめる。
公開（GitHub Pages）は、`site.yml` の `deploy` ジョブを、持ち主が Pages を有効にしたあと `main` で手動実行したときだけ動く。

## 構成

| パス | 内容 |
|---|---|
| `src/storage/block-store.ts` | `ChunkedBlockStore` 本体。遅延取得、overlay（Copy-on-Write）、LRU、ライトバック（定期・アイドル・しきい値） |
| `src/storage/kv-idb.ts` | IndexedDB 版のKVバックエンド |
| `src/storage/kv-memory.ts` | メモリ版のKVバックエンド（テスト用） |
| `src/storage/http-source.ts` | HTTP からのチャンク取得（Range 方式 / チャンクファイル方式、再試行つき） |
| `src/storage/lifecycle.ts` | ページ離脱時の flush、ストレージ永続化の要求 |
| `src/storage/lock.ts` | Web Locks による複数タブの排他 |
| `src/engine/v86-block-device.ts` | `BlockStore` を v86 のディスク（hda）として見せるアダプタ |
| `src/engine/types.ts` / `src/engine/v86-engine.ts` | エンジンの差し替え口（`Engine`）と、v86 用の実装（`V86Engine`。シリアルをターミナルに使う） |
| `app/` | ターミナルアプリ本体（xterm.js、保存状態の表示、ディスクの初期化）。`npm run site:build` が `site/` にまとめる |
| `image/` | Alpine（Node.js・Python 入り）の ext4 イメージのビルドと、外付け initrd（`/wasmbox-init`）。[image/README.md](./image/README.md) |
| `poc/` | v86 に接続して起動するページ（`alpine.html`）と、v86 不要のブラウザ自己診断（`selftest.html`）。[poc/README.md](./poc/README.md) |
| `tools/chunk-image.ts` | ディスクイメージを チャンク + manifest.json に分割する |
| `tools/make-initrd.ts` | 直接ルート起動用の外付け initrd を作る |
| `tools/alpine-smoke.mjs` / `tools/persist-smoke.mjs` | 実ブラウザ（Playwright）+ v86 + Alpine の自動確認。起動・Node.js・Python と、永続化 |
| `tools/app-smoke.mjs` | ターミナルアプリの自動確認（起動・入力・保存表示・再読み込み・初期化） |
| `tools/selftest-browsers.mjs` | `poc/selftest.html` を Chromium・Firefox・WebKit で実行する |
| `tools/build-site.ts` / `tools/prepare-vendor.sh` | 公開用の `site/` の組み立てと、`poc/vendor/` の用意 |
| `tools/serve.ts` | 開発用の静的サーバー（依存なし） |

## 使い方

```ts
import {
  ChunkedBlockStore, HttpChunkSource, IdbKV,
  acquireInstanceLock, installAutoFlush, requestPersistentStorage,
} from "./src/storage/index.ts";

const manifest = await (await fetch("/image/manifest.json")).json();

await requestPersistentStorage();
const release = await acquireInstanceLock("default"); // 別タブが使用中なら InstanceLockedError

const store = await ChunkedBlockStore.open({
  manifest,
  source: new HttpChunkSource({
    layout: { kind: "chunk-files", urlFor: (_i, hash) => `/image/chunks/${hash}` },
  }),
  baseCache: await IdbKV.open("wasmbox-base-cache", { durability: "relaxed" }),
  instance: await IdbKV.open("wasmbox-instance-default", { durability: "strict" }),
  flushIntervalMs: 1000, // 定期 flush
  flushIdleMs: 150,      // 最後の書き込みから 150ms 止まったら flush（v86 は sync を伝えないので、この併用を勧める）
});
installAutoFlush(store); // ※ Worker 内では pagehide が届かない。メインスレッド側で使うこと

await store.read(0, 512);
await store.write(0, new Uint8Array([1, 2, 3]));
await store.flush(); // IndexedDB への保存完了まで待つ
```

v86 に繋ぐときは `new V86BlockDevice(store)` を `hda` に渡す（`poc/alpine.ts` が実例）。

イメージの分割:

```sh
node tools/chunk-image.ts rootfs.img out/ --chunk-size=262144 --image-id=alpine-base
# → out/manifest.json と out/chunks/<sha256>
```

## 検証状況

何を・どこまで確認したかを区別して書く（詳しい方針は [AGENTS.md](./AGENTS.md)）。
「実ブラウザ + v86 + Alpine」と「永続化」「性能」は、GitHub Actions のランナー（ubuntu-24.04）上のヘッドレス Chromium（Playwright）で確認したもの（2026-10-15）。

- ✅ **ユニットテスト**（`npm test`）: メモリ上のKVと `fake-indexeddb` の両方で通過。競合まわり（flush 中の追記、読み込み中の書き込み、
  flush 失敗後の復元）と、アダプタのコピー・順序保証は、実装をわざと壊すとテストが落ちることも確認済み。
- ✅ **クラッシュ時の一貫性**（`test/crash-consistency.test.ts`）: ランダムな書き込み・flush・flush 失敗を並行させ、KV への保存が起きるたびの内容
  （= どの瞬間に落ちた場合の保存内容でも）が「書き込みを先頭から k 個適用した状態」になることを確認した。進行中の 1 回の書き込みだけは、
  チャンク境界で途中まで反映されうる。flush の原子性を壊す・flush 中のスナップショットを書き換える、という 2 通りの改悪で、このテストが落ちることも確認済み。
- ✅ **実ブラウザ（v86 なし）**: Chromium 141 で `poc/selftest.html` が成功。IndexedDB への書き込みと flush、
  **ブラウザを完全に閉じて開き直したあとの読み出し**、HTTP からのチャンク取得（実 `fetch` + 実 SHA-256 検証）、IndexedDB キャッシュからの再読み込み
  （再起動後はネットワークへのリクエストが 0 回）を確認した。空のプロファイルでは失敗することも確認済み。
- ✅ **実ブラウザ + v86 + Alpine**（`tools/alpine-smoke.mjs`）: 外付け initrd → `switch_root` で ext4 がルートになる直接ルート起動を、3 回連続で確認。
  Alpine 3.21（i386）上で Node.js v22.23.2 と Python 3.12.15 が動く。
- ✅ **永続化**（`tools/persist-smoke.mjs`）: ゲストが書いたファイルが、ブラウザを完全に閉じて開き直したあとも、リロードしたあとも残る。
  保存前に閉じたあとの起動で、ext4 はジャーナルから回復して起動できる（`recovery complete`）。
- ⚠️ **ゲストの `sync` は IndexedDB への保存を保証しない**（v86 が FLUSH CACHE をディスクに伝えないため）。
  実測では、`sync` の直後（保存前）にブラウザを閉じる、またはリロードすると、そのファイルは失われた。
  アイドル flush（150 ms）と定期 flush（1 秒）で縮めているが、**最後の書き込みから約 150 ms ＋ 保存時間のあいだに閉じると失われうる**。詳しくは ARCHITECTURE.md 4.3。
- ✅ **ターミナルアプリ**（`tools/app-smoke.mjs`、CI の Chromium + v86 + Alpine。2026-10-17）: 起動 → キーボード入力 → Node.js 実行 →
  「保存済み」表示 → 再読み込みしても残る → 「ディスクを初期化」で消える、までが通る。シェルが使えるまで 7.3 秒（初回）／6.4 秒（再読み込み後）／5.7 秒（初期化後）。
  日本語の文字列（`insertText`）もゲストへ届く。サイトは 122 MiB（429 チャンク）。
- ✅ **複数ブラウザ**（`tools/selftest-browsers.mjs`、CI。2026-10-17）: Storage 層とアダプタの自己診断（読み書き・flush・開き直し・HTTP 取得・キャッシュ・Web Locks の排他）が、
  Chromium 156・Firefox 157・WebKit 27.2 で 22 件すべて成功。**WebKit は Playwright の WebKit で、Safari そのものではない。**
- ✅ **容量不足の対応**（`test/quota.test.ts`）: overlay の保存が `QuotaExceededError` で断られたら、base キャッシュを捨てて 1 回だけやり直す。overlay は捨てない。
  実装をわざと壊した 4 通りで、テストが落ちることを確認済み。
- ⚠️ **未確認**: 実際の Safari・モバイル・Windows / macOS。v86 + Alpine の起動は Chromium のみ。実ブラウザで容量不足になったときの挙動。
  貼り付け・実際の IME 入力・`vim` など画面全体を使うプログラム。2 つ目のタブを開いたときのアプリの表示。GitHub Pages 上での動作（Pages 未有効化）。
  実物の xterm.js の見た目（画面のレイアウトは、偽のターミナルを使ってローカルで目視した。xterm.js の描画そのものは、人の目では見ていない）。
- ⚠️ **ターミナルの制約**: 大きさは 80×24 固定。ゲストから見た `TERM` は `vt102`（実測）。ネットワークにはつながらない。
- ⚠️ **性能は、CI のランナー上の値**。起動してシェルが使えるまで 5.1〜6.6 秒、`node -e "console.log(1)"` が 1.9〜2.6 秒、
  `python3 -c "print(1)"` が 1.5〜2.5 秒（ゲストの `time`。RAM 256 MiB）。利用者のマシンでは変わる。チャンクサイズ 256 KiB の妥当性は未検証。

## 未実装・今後

- `navigator.storage.estimate()` を見て、容量が尽きる**前**に base キャッシュを捨てること（いまは、断られてから動く。ARCHITECTURE.md 4.5）
- エミュレータの Web Worker 化（いまはメインスレッド。ARCHITECTURE.md 8 章）
- 公開（持ち主の判断が要る: Pages の有効化、`LICENSE`、GPL の部品のソース提供。[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）
- ゲストの fsync を flush につなぐ手段（v86 の改造が必要。現状は受け入れている。ARCHITECTURE.md 4.3）
- v86 の `save_state` / `restore_state` への対応（M6）
- ゲストからのネットワーク（M6）
- チャンクの圧縮配信
