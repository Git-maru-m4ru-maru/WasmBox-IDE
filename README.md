# WasmBox

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

CI（.github/workflows/site.yml）は、同じ手順でビルドして実ブラウザで検証する。ワークフローには GitHub Pages への手動デプロイも用意してあり、通常の push だけでは公開されない。
IDE を公開するには、リポジトリの Settings → Pages → Build and deployment → Source を「GitHub Actions」に設定し、Actions → Site (terminal app) から main を選んで Run workflow を実行する。公開後の IDE はサイト URL の末尾に ide.html を付けたページになる。
公開前に仮想 Linux・v86・xterm.js などの配布条件を確認すること。詳細は [docs/PUBLISHING.md](./docs/PUBLISHING.md)。
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
| `src/engine/network.ts` / `app/network-setting.ts` | ネットワークの設定（`NetworkConfig` の検査と v86 の `net_device` への変換 / アプリの設定欄の保存・検査） |
| `app/` | ターミナルアプリ本体（xterm.js、保存状態の表示、ディスクの初期化）。`npm run site:build` が `site/` にまとめる |
| `image/` | Alpine（Node.js・Python 入り）の ext4 イメージのビルドと、外付け initrd（`/wasmbox-init`）。[image/README.md](./image/README.md) |
| `poc/` | v86 に接続して起動するページ（`alpine.html`）と、v86 不要のブラウザ自己診断（`selftest.html`）。[poc/README.md](./poc/README.md) |
| `tools/chunk-image.ts` | ディスクイメージを チャンク + manifest.json に分割する |
| `tools/make-initrd.ts` | 直接ルート起動用の外付け initrd を作る |
| `tools/alpine-smoke.mjs` / `tools/persist-smoke.mjs` | 実ブラウザ（Playwright）+ v86 + Alpine の自動確認。起動・Node.js・Python と、永続化 |
| `tools/app-smoke.mjs` | ターミナルアプリの自動確認（起動・入力・保存表示・再読み込み・初期化） |
| `tools/net-smoke.mjs` / `tools/step-judge.ts` | ネットワークの自動確認（オフ / WISP リレー / fetch。`tools/relay.mjs` と通信先を runner 上で起動する）と、結果の判定 |
| `tools/relay.mjs` / `tools/relay-policy.ts` | 手元・自分のサーバー用の WISP リレー（`npm run relay`）と、その方針（接続先は IPv4 アドレスだけ・Origin・ポート・UDP） |
| `tools/relay-check.mjs` / `tools/relay-check-lib.ts` | リレーの接続先フィルタが、内部のアドレスへの接続を断るかの検査（`npm run relay:check`。WISP のサーバーなら何に対しても使える） |
| `tools/relay/Dockerfile` / [docs/relay.md](./docs/relay.md) | リレーのコンテナと、自分のサーバーで動かす手順（TLS のリバースプロキシ・出口のファイアウォール・止める手順） |
| `tools/selftest-browsers.mjs` | `poc/selftest.html` を Chromium・Firefox・WebKit で実行する |
| `tools/build-site.ts` / `tools/prepare-vendor.sh` | 公開用の `site/` の組み立てと、`poc/vendor/` の用意 |
| `tools/serve.ts` | 開発用の静的サーバー（依存なし） |

## ネットワーク（実験的。既定はオフ）

アプリの「ネットワーク」欄で選ぶ。変えると、保存して再読み込みする（ディスクの内容は残る）。

| 方式 | 通るもの | 必要なもの |
|---|---|---|
| オフ（既定） | ループバック（127.0.0.1）だけ | — |
| ブラウザのみ（fetch） | ゲストの HTTP（80 番）だけ。相手が CORS を許可している場合のみ。`N.external` と書くと、ブラウザから見た `localhost:N` へ届く | なし |
| リレー経由（WISP） | TCP 全般。HTTPS、`apk`、`pip`、`npm` も通る | WISP サーバー（リレー） |

`apk add` や `npm install` が目的なら「リレー経由」を使う。**リレーは自分で用意する。公開リレーは運営しない**（持ち主の決定、2026-10-20。
運営・費用・悪用への対策の調査は ARCHITECTURE.md 5.2）。自分のマシンでは、1 コマンドで起動できる:

```sh
npm install --no-save --package-lock=false @mercuryworkshop/wisp-js@0.5.0   # リレーの部品（package.json は変わらない）
npm run relay                                                                # wisp://127.0.0.1:5001/ で待ち受ける
```

`npm run relay` は、wisp-js に次の方針を足して起動する（詳しくは [docs/relay.md](./docs/relay.md)）:
接続先は**ドット区切りの IPv4 アドレスだけ**（wisp-js 0.5.0 の既定のフィルタを `::ffff:127.0.0.1` で迂回できるため）、
ループバック・プライベート・リンクローカルへは届けない、**許可した Origin のページからだけ**接続できる（既定は `http://localhost:8080` と `http://127.0.0.1:8080`）、
ゲストが接続できるポートは既定で 80 と 443 だけ、UDP は既定で断る。`npm run relay -- --help` でオプションの一覧。
フィルタの確認は `npm run relay:check -- wisp://127.0.0.1:5001/`。

`npm run site:serve` で `http://127.0.0.1:8080/` を開き、ネットワーク欄で「リレー経由」を選んで、URL に `wisp://127.0.0.1:5001/` を入れる。
ゲストの中では、起動時に DHCP でアドレスを取る（`/run/wasmbox-net.log` に経過が残る）。そのあとは、ふつうに使える:

```sh
apk update && apk add jq
```

自分で公開したサイト（https）から使うときは、リレーを TLS で包み（リバースプロキシの後ろに置く）、`wisps://` か `wss://` の URL を入れる。
https のページは、暗号化されない `ws://` / `wisp://` には接続できない（設定欄で断る）。Docker・TLS のリバースプロキシ・出口のファイアウォールの手順は [docs/relay.md](./docs/relay.md)。
🔬 TLS 付きのリレーと出口のファイアウォールは、まだ試していない。

CI での実測（Chromium 156、v86 0.5、wisp-js 0.5.0。リレーは同じマシン上なので、遅延は実環境より小さい。2026-10-18）:

| 操作 | 時間 |
|---|---|
| 8 MiB のダウンロード（`wget`） | 4.4 秒（ne2k）／ 5.0 秒（virtio） ≒ 1.6〜1.8 MiB/秒 |
| `wget https://example.com/`（HTTP の同じ操作は 0.3 秒） | 3.6 秒 |
| `apk update` ／ `apk add jq` | 約 10 秒 ／ 約 9 秒 |
| `apk add npm`（Node.js の npm と依存） | 28〜30 秒 |
| Python の `urllib` で HTTPS の GET ／ Node.js の `fetch` で HTTPS の GET | 11 秒 ／ 26 秒 |
| `npm view is-odd version` ／ `npm install is-odd`（2 パッケージ） | 47〜51 秒 ／ 約 50 秒 |

2026-10-21 の CI では、リレーを `tools/relay.mjs`（接続先は IPv4 だけ・UDP なし）に替えても、同じ操作がすべて成功した（ne2k と virtio。警告・失敗は 0 件）。
時間は同程度（8 MiB が 3.0〜3.3 秒、`apk update` が 5.8〜6.6 秒、`apk add npm` が 20〜24 秒、`npm install` が 36〜41 秒）。
つまり、v86 は接続先を IPv4 アドレスで送り、通常の通信（DNS・HTTPS・パッケージの導入）に UDP は要らない。
（この確認では、runner 上の通信先（9090 番）へ届けるために `--ports all --unsafe-allow-private` を付けた。既定の 80 / 443 だけの制限は、ゲストの通信では試していない。上の通信先は、いずれも 80 か 443 を使う。）

HTTPS が重いのは、TLS の処理を、エミュレートした CPU でやるためと考えている（原因は未検証）。ネットワークをオンにしても、シェルが使えるまでの時間は大きくは変わらない（オフ 7.3 秒、リレー 6.7〜6.8 秒、fetch 7.4 秒。1 回ずつの測定で、差は誤差の範囲と見ている）。

注意:

- ⚠️ **リレーの運営者には、ゲストの通信先（IP とポート）が見える。HTTP の中身も見える。** HTTPS は、ゲストの中で TLS を終えるので、中身はリレーに見えない。
- ⚠️ **公開リレーは、誰でも使える踏み台（オープンプロキシ）になる。** 運営しない（持ち主の決定）。自分のサーバーに置くなら、[docs/relay.md](./docs/relay.md) の対策が要る。
  wisp-js 0.5.0 は、既定で、ループバック・プライベート IP・リンクローカル（169.254.x）などへの接続を拒否するが、
  **IPv4 マッピングの IPv6 表記（`::ffff:127.0.0.1` など）では、拒否をすり抜けた**（CI で確認。`npm run relay` は、接続先を IPv4 アドレスだけにして、この迂回を塞ぐ）。
  wisp-js 自体には、接続元の Origin の確認と、クライアント IP ごとの制限・認証がない（`npm run relay` は Origin の確認を足している。IP ごとの制限と認証は、リバースプロキシで行う）。
  内部への出口は、ファイアウォールなどネットワーク側でも塞ぐこと。
- ⚠️ ネットワークをオンにすると、ゲストの中のプログラムは、リレーを通して外へ出られる。信頼できないコードを動かすときは、オフのままにする。
- ⚠️ 名前の解決（DNS）は、v86 の内蔵の DNS が、ブラウザから DoH で行う（v86 のオプションの既定。リレーの通信先は IP アドレスで届いていた）。
  🔬 問い合わせ先の DoH サーバーは確認していない。
- ⚠️ 通るのは TCP だけと理解している（v86 の WISP）。`npm run relay` は UDP を断る（DNS・DHCP・`apk`・`npm` はそれで通った）。UDP を使うアプリと ping（ICMP）は試していない。
- リレーの URL は、利用者が欄に入れたものだけを使う（ブラウザの localStorage に保存）。リンクの `?relay=` などのパラメータは、自動テスト用の `?smoke=1` のときだけ効く。
- NIC は ne2k（v86 の既定）。virtio も動くことを確認した。設定欄には出していない。

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
- ✅ **ネットワーク**（`tools/net-smoke.mjs`、CI の Chromium 156 + v86 0.5 + Alpine + wisp-js 0.5.0。2026-10-18。詳しくは「ネットワーク」）:
  WISP リレー経由で、DHCP・DNS・HTTP・HTTPS・`apk update` / `apk add`・Python と Node.js の HTTPS・`npm view` / `npm install` が通る（ne2k と virtio の両方）。
  オフのときは lo だけ（外へは出ない）。fetch 方式は、HTTP の 80 番だけで、CORS を許可しない相手には届かない。
  設定の検査・保存・復元は、ユニットテストと、偽の v86 を使った実ブラウザでの確認（変異で検出を確認）。
- ✅ **手元用のリレー**（`npm run relay` / `npm run relay:check`。2026-10-21）: 実物の wisp-js 0.5.0 に対する結合テスト（`test/relay.integration.test.ts` ほか 48 件。この環境と CI の両方）。
  内部（ループバック・IPv4 マッピング・プライベート）に置いた見張り役の TCP サーバーに、リレー越しで届かないこと、ポート・UDP・Origin・パスの制限、
  wisp-js の既定のままでは `::ffff:127.0.0.1` が断られないこと（対照）を確認。接続先の絞り込み・ポート・UDP・ループバックの許可・Origin・パス・IPv4 の正規形を壊す 7 通りの改悪で、それぞれテストが落ちる。
  v86 + Alpine のゲストが、このリレー越しで DHCP・DNS・HTTPS・`apk`・Python・Node.js・`npm install` まで通る（CI の `tools/net-smoke.mjs`）。
  🔬 未確認: TLS のリバースプロキシ（`wisps://`）、出口のファイアウォール、インターネット越しの遅延、複数人での利用（[docs/relay.md](./docs/relay.md) の「確認の状況」）。
- ⚠️ **未確認**: 実際の Safari・モバイル・Windows / macOS。v86 + Alpine の起動は Chromium のみ（ネットワークも Chromium のみ）。実ブラウザで容量不足になったときの挙動。
  貼り付け・実際の IME 入力・`vim` など画面全体を使うプログラム。2 つ目のタブを開いたときのアプリの表示。GitHub Pages 上での**アプリ**の動作（Pages にはアプリを公開していない）。
  実物の xterm.js の見た目（画面のレイアウトは、偽のターミナルを使ってローカルで目視した。xterm.js の描画そのものは、人の目では見ていない）。
- ⚠️ **ターミナルの制約**: 大きさは 80×24 固定。ゲストから見た `TERM` は `vt102`（実測）。ネットワークは既定でオフ（「ネットワーク」を参照）。
- ⚠️ **性能は、CI のランナー上の値**。起動してシェルが使えるまで 5.1〜6.6 秒、`node -e "console.log(1)"` が 1.9〜2.6 秒、
  `python3 -c "print(1)"` が 1.5〜2.5 秒（ゲストの `time`。RAM 256 MiB）。利用者のマシンでは変わる。チャンクサイズ 256 KiB の妥当性は未検証。

## 未実装・今後

- `navigator.storage.estimate()` を見て、容量が尽きる**前**に base キャッシュを捨てること（いまは、断られてから動く。ARCHITECTURE.md 4.5）
- エミュレータの Web Worker 化（いまはメインスレッド。ARCHITECTURE.md 8 章）
- アプリ本体の公開（いまの方針は「Pages に載せない」。将来公開するときは、持ち主の判断が要る: Pages の設定、GPL の部品のソース提供、著作権表示。[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）
- ゲストの fsync を flush につなぐ手段（v86 の改造が必要。現状は受け入れている。ARCHITECTURE.md 4.3）
- v86 の `save_state` / `restore_state` への対応（M6）
- ネットワークの残り: 🔬 TLS 付きのリレー（`wisps://` / `wss://`）、https のページからの動作、インターネット越しのリレー、Firefox / WebKit での動作（いずれも未確認）。
  公開リレーは運営しない（持ち主の決定、2026-10-20）。自分のサーバーで動かす手順は [docs/relay.md](./docs/relay.md)
- チャンクの圧縮配信

## ライセンス

WasmBox 自身のコードは **GPL-3.0 の「以降のバージョンも許す」形（GPL-3.0-or-later）**（[LICENSE](./LICENSE)。持ち主の決定、2026-10-19）。
`package.json` の `license` は `GPL-3.0-or-later`。著作権表示（`Copyright (C) 年 名前`）は、持ち主の方針で入れない。

許諾の文面（GPL-3.0 の末尾の「適用のしかた」にある標準の文面。著作権の行は入れない。「以降のバージョンも許す」という意思は、ここで示す）:

```text
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

- v86・xterm.js・Linux カーネル・busybox など、配るときに含まれる他者の部品は、それぞれのライセンスのまま。関係の整理は [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
- ファイルごとの許諾の表示（`SPDX-License-Identifier` など）は、まだ入れていない。
