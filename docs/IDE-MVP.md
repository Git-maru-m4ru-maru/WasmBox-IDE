# WasmBox IDE MVP

WasmBox IDE は、既存の WasmBox 仮想 Linux を再利用するブラウザ内 IDE です。専用のユーザー実行サーバーを用意せず、ブラウザ内で編集・保存し、仮想 Linux でコードを実行します。

## 機能

- ファイル一覧、行番号、構文ハイライト付きコード編集
- Python、JavaScript / TypeScript、HTML、CSS、JSON、Markdown の構文ハイライト
- CodeMirror 6 が読み込めない場合に使う簡易エディタ
- 新規ファイル作成、キーボードショートカット、実行結果表示
- IndexedDB への自動保存
- JSON 形式のプロジェクト読み込み・書き出し
- Python、Node.js、Shell スクリプトの実行
- ファイル名・サイズ・プロジェクト容量の検証
- Linux 仮想ディスクの保存は既存 WasmBox の仕組みを利用

CodeMirror 6 はバージョンを固定した ESM モジュールを esm.sh から読み込みます。読み込みに失敗した場合は、既存のテキストエディタで編集を続けられます。初回の構文ハイライト利用にはインターネット接続が必要です。

プロジェクトは最大30ファイル、1ファイル32 KiB、合計64 KiBです。プロジェクトとコードは現在のブラウザ内に保存されます。別の端末との同期やアカウント連携は含みません。

## 開発・検証

開発環境では Node.js 22.18 以上と npm を使い、次を実行します。

    npm ci
    npm run typecheck
    npm test
    npm run site:build

サイト全体を組み立てるには、別途 bash image/build.sh と bash tools/prepare-vendor.sh も必要です。実際のブラウザでの検証は GitHub Actions の Site (terminal app) ワークフローで行います。IDE smoke test は Chromium と v86 / Alpine を使い、Python・Node.js・Shell の実行、IndexedDB 保存・再読み込みを確認します。

ビルド済みサイトでは /ide.html を開きます。公開手順は [PUBLISHING.md](./PUBLISHING.md) を参照してください。
