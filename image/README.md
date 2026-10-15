# Alpine ルートFSイメージ

32bit x86 の Alpine（Node.js・Python 入り）を ext4 のイメージにまとめ、内容アドレス方式のチャンクに分割して、v86 の BlockStore から配信する。

確認状況（2026-10-15、GitHub Actions の実ブラウザ。`tools/alpine-smoke.mjs`）:

- ✅ 外付け initrd による直接ルート起動（`rdinit=/wasmbox-init` → `switch_root`）を 3 回連続で確認。`/proc/mounts` で `/dev/sda / ext4` になる。
- ✅ Alpine 3.21 の上で Node.js v22.23.2 と Python 3.12.15 が動く。

## ビルド

必要なもの: BuildKit が使える Docker と、Node.js 22.18 以上。

```sh
bash image/build.sh
```

環境変数（任意）:

| 変数 | 既定値 | 内容 |
|---|---|---|
| ALPINE_VERSION | 3.21 | Alpine のリリース |
| PACKAGES | nodejs python3 | ゲストのイメージに入れるパッケージ |
| IMAGE_SIZE_MIB | 512 | 仮想ディスクの大きさ |
| CHUNK_SIZE | 262144 | チャンクのバイト数 |

ビルドすると `image/out/rootfs.ext4` と、`poc/image/manifest.json`・`poc/image/chunks/`・`poc/image/initrd.cpio` ができる。
チャンクから復元したイメージを `e2fsck` で検査するところまで行う。

## ブラウザで動かす

1. `poc/README.md` に従って、v86 一式とディスク対応カーネルを `poc/vendor/` に置く。
2. `npm run poc` を実行する。
3. http://127.0.0.1:8080/alpine.html を開く。

URL パラメータ:

| パラメータ | 内容 |
|---|---|
| `?memory=512` | ゲストの RAM（MiB。64〜2048。既定 256） |
| `?root=/dev/hda` | ルートのデバイス名（既定 `/dev/sda`） |
| `?kernel=...` / `?cmdline=...` | カーネルのパス / カーネルのコマンドライン |
| `?image=image` | イメージのディレクトリ |
| `?initrd=none` / `?initrd=...` | 外付け initrd を使わない / 明示的に指定する |
| `?flushidle=150` / `?flushinterval=1000` | アイドル flush / 定期 flush の時間（ms）。検証用 |
| `?autoflush=off` | ページ離脱時の flush を外す。検証用 |
| `?smoke=1` | 自動テストが使うフックを `window` に公開する。検証用 |

## 直接ルート起動のしくみ（外付け initrd）

使っているカーネル（`buildroot-bzimage68_v86.bin`）は、内蔵の initramfs の `/init` が Buildroot 環境（プロンプト `~% `）を起動し、
v86 のホスト 9p を `/mnt` にマウントしようとする。そのため、`root=` を渡すだけでは Alpine が PID 1 にならない。

そこで `tools/make-initrd.ts` が、`/wasmbox-init` と最小のデバイスノードだけを入れた、無圧縮の `newc` 形式の cpio を作る。
`poc/alpine.ts` はそれを v86 に渡し、コマンドラインに `rdinit=/wasmbox-init` を足す。

`/wasmbox-init`（`image/initrd/wasmbox-init`）は、`root=` と `rootfstype=` を読み、デバイスが現れるまで最大 15 秒待ち、ext4 をマウントし、
`/sbin/init` があるのを確かめて `switch_root /newroot /sbin/init` する。失敗したら `chroot` で代用し、それも駄目ならレスキュー用のシェルを残す。

切り替える前に `[wasmbox-init] ルート: /dev/sda（ext4）` と表示する。ただし、Alpine がコンソールを初期化するときにシリアルの
テキストエリアが描き直されることがあり、この行が残っていないことだけでは、initrd の失敗とは言えない。
起動後の確実な確認方法は次のとおりで、`/dev/sda / ext4 ...` と表示されればよい。

```sh
grep -E '^(/dev/(sd|hd)[a-z]+) / ext4 ' /proc/mounts
```

## ゲスト内の確認

自動テスト（`tools/alpine-smoke.mjs`）は、Alpine のルートで次のコマンドを実行する。

```sh
cat /etc/alpine-release
node --version
node -e "console.log(1 + 1)"
python3 --version
free -m
time node -e "console.log(1)"
time python3 -c "print(1)"
```

実測値（シェルが使えるまでの時間、コマンドの時間、メモリ）は ARCHITECTURE.md の 6・7 章に載せている。
永続化の確認（`tools/persist-smoke.mjs`）は ARCHITECTURE.md の 4.3 を参照。

## トラブルシュート

| 症状 | 次に確認すること |
|---|---|
| Alpine の ext4 がマウントできない | `/dev/sda` と `/dev/hda` の両方を試す。`/proc/partitions` と `dmesg` を見る |
| Buildroot のプロンプト `~% ` が出たまま、`[wasmbox-init]` の行がない | initrd の URL と、コマンドラインの `rdinit=` を確認する |
| デバイスが見つからない | `/proc/partitions` を見る |
| マウントに失敗する | `dmesg \| tail` と、ext4 の機能フラグを見る |
| Node.js が `Illegal instruction` になる | `/proc/cpuinfo` を見る。今のゲストは SSE2 まで（SSE3 なし） |
| プロセスが kill される | `?memory=512` で RAM を増やす |
| 「別のイメージのものです」と出る | 新しい manifest を読み込む前に、ディスクの overlay を初期化する |

## 設計メモ

- パッケージは、ゲストの中ではなく、イメージのビルド時に入れる。
- ext4 は、古いカーネルとの互換のため `metadata_csum`・`64bit`・`orphan_file` を無効にして作る。ジャーナルは有効のまま。
- 既定のイメージは 512 MiB。ゼロ埋めのチャンクは配信しないので、使っていない領域をダウンロードする必要はない。
- BlockStore への書き込みは、定期・アイドル・しきい値で flush される。ただし、ゲストのファイルシステムの書き込み順序が flush の境目と一致する保証はない。
  保存前にタブを閉じても、ext4 のジャーナルで回復して起動できることは実測で確認した（ARCHITECTURE.md 4.3）。
