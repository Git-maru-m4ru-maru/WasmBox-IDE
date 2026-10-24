# WasmBox の公開手順

WasmBox は静的ファイルとして配信し、Linux とユーザーコードの実行は利用者のブラウザ内で行います。ユーザーごとの実行サーバーは必要ありません。

## GitHub Pages で公開する

このリポジトリには、サイトをビルドして GitHub Pages にデプロイする GitHub Actions ワークフローが用意されています。通常の push だけでは公開されず、設定を行ったあとに手動で実行します。

1. リポジトリの **Settings → Pages** を開きます。
2. **Build and deployment → Source** を **GitHub Actions** に設定して保存します。
3. **Actions → Site (terminal app)** を開きます。
4. **Run workflow** を押し、ブランチに main を指定して実行します。
5. ワークフローのビルド、IDE / ターミナルのブラウザテスト、デプロイが成功したら、**Settings → Pages** に表示される **Visit site** を開きます。

サイトのルート / は従来のターミナルアプリです。IDE は同じ URL の末尾に ide.html を追加して開きます。たとえば Visit site の URL が https://owner.github.io/WasmBox-IDE/ なら IDE の URL は https://owner.github.io/WasmBox-IDE/ide.html です。実際の URL は GitHub の Pages 設定に表示されたものを使ってください。

## 公開前の確認

- [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) と各コンポーネントのライセンス条件を確認してください。公開サイトには仮想 Linux イメージ、v86、xterm.js などの配布用アセットが含まれます。
- サイトは現在およそ 122 MiB で、Linux ディスクを多数の小さなチャンクに分割しています。GitHub Pages の公開サイト上限は 1 GB です。利用者が増えて転送量が大きくなった場合は別の静的ホスティングへの移行を検討してください。
- IDE の構文ハイライトは、バージョン固定した CodeMirror 6 の ESM モジュールを esm.sh から読み込みます。ネットワークや CDN の障害時には簡易エディタにフォールバックします。
- プロジェクトは IndexedDB に保存され、別端末への同期はありません。ブラウザのデータ削除やストレージ制限によって編集内容が失われる可能性があります。

## Cloudflare Pages を使う場合

このリポジトリのビルドは Linux イメージ作成に Docker を使うため、Cloudflare Pages の Git 連携で npm run site:build だけを実行してもサイトは完成しません。GitHub Actions 上で既存の site.yml と同じビルド手順を実行し、その成果物を Wrangler で Pages にデプロイする構成が必要です。Cloudflare Pages Free は現行の仕様でサイトあたり最大20,000ファイル、単一ファイル25 MiBの制限があります。現在の分割済みイメージはこの方式に合わせた構成ですが、デプロイ前に実際の成果物のファイル数と各サイズを検証してください。
