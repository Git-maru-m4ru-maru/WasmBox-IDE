#!/usr/bin/env bash
# ブラウザで読み込む外部ファイル（v86、BIOS、カーネル、xterm.js）を poc/vendor/ に用意する。
# poc/vendor/ はコミットしない（再配布の条件は、公開前に確認すること。THIRD_PARTY_NOTICES.md）。
#
# 前提: node_modules に v86 と @xterm/xterm が入っていること。例:
#   npm install --no-save --package-lock=false v86@0.5 @xterm/xterm@5.5.0
# （--no-save のインストールは、package.json にない他のパッケージを消す。playwright なども同じ 1 回で指定すること）
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=poc/vendor
V86_BUILDROOT_VERSION="${V86_BUILDROOT_VERSION:-1.0.2}"

for path in node_modules/v86/build/libv86.js node_modules/v86/build/v86.wasm \
            node_modules/@xterm/xterm/lib/xterm.js node_modules/@xterm/xterm/css/xterm.css; do
  [ -f "$path" ] || { echo "$path がありません。先に npm install --no-save --package-lock=false v86@0.5 @xterm/xterm@5.5.0 を実行してください。" >&2; exit 1; }
done

mkdir -p "$VENDOR"
cp node_modules/v86/build/libv86.js "$VENDOR/libv86.js"
cp node_modules/v86/build/v86.wasm "$VENDOR/v86.wasm"
cp node_modules/@xterm/xterm/lib/xterm.js "$VENDOR/xterm.js"
cp node_modules/@xterm/xterm/css/xterm.css "$VENDOR/xterm.css"

curl -fL https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin -o "$VENDOR/seabios.bin"
curl -fL https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin -o "$VENDOR/vgabios.bin"

TARBALL="$(mktemp)"
trap 'rm -f "$TARBALL"' EXIT
curl -fL "https://github.com/chschnell/v86-buildroot/releases/download/v${V86_BUILDROOT_VERSION}/v86-buildroot-${V86_BUILDROOT_VERSION}.tar.bz2" -o "$TARBALL"
tar -xjf "$TARBALL" -C "$VENDOR" buildroot-bzimage68_v86.bin
mv "$VENDOR/buildroot-bzimage68_v86.bin" "$VENDOR/buildroot-bzimage.bin"

echo "完了: $VENDOR/ に用意しました。"
ls -l "$VENDOR"
