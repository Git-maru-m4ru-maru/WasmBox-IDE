# WasmBox

ブラウザ内で動く、WASM上の仮想Linux環境。設計は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

v86（x86 エミュレータ）の上で Alpine Linux（Node.js・Python 入り）が動き、ディスクは IndexedDB に永続化される。
**M1〜M5 は実ブラウザで確認済み**（確認の内容と、確認していないことは「検証状況」を参照）。進み具合は ARCHITECTURE.md の 9 章。
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
| `image/` | Alpine（Node.js・Python 入り）の ext4 イメージのビルドと、外付け initrd（`/wasmbox-init`）。[image/README.md](./image/README.md) |
| `poc/` | v86 に接続して起動するページ（`alpine.html`）と、v86 不要のブラウザ自己診断（`selftest.html`）。[poc/README.md](./poc/README.md) |
| `tools/chunk-image.ts` | ディスクイメージを チャンク + manifest.json に分割する |
| `tools/make-initrd.ts` | 直接ルート起動用の外付け initrd を作る |
| `tools/alpine-smoke.mjs` / `tools/persist-smoke.mjs` | 実ブラウザ（Playwright）+ v86 + Alpine の自動確認。起動・Node.js・Python と、永続化 |
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
- ⚠️ **Firefox / Safari は未確認。** `poc/selftest.html` で、各ブラウザの結果を確かめられる。
- ⚠️ **性能は、CI のランナー上の値**。起動してシェルが使えるまで 5.1〜6.6 秒、`node -e "console.log(1)"` が 1.9〜2.6 秒、
  `python3 -c "print(1)"` が 1.5〜2.5 秒（ゲストの `time`。RAM 256 MiB）。利用者のマシンでは変わる。チャンクサイズ 256 KiB の妥当性は未検証。

## 未実装・今後

- base キャッシュの容量逼迫時の退避（ARCHITECTURE.md 4.5）
- ゲストの fsync を flush につなぐ手段（v86 の改造が必要。現状は受け入れている。ARCHITECTURE.md 4.3）
- v86 の `save_state` / `restore_state` への対応（M6）
- ゲストからのネットワーク（M6）
- チャンクの圧縮配信
