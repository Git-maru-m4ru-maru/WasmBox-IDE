#!/usr/bin/env node
// WasmBox 用の WISP リレー（手元・自分のサーバー用）。`npm run relay` で起動する。
//
// wisp-js（@mercuryworkshop/wisp-js、LGPL-3.0-or-later）をそのまま使い、起動の前後に次の方針を足す（tools/relay-policy.ts）:
//   - 接続先は、正規形の IPv4 アドレスだけ（wisp-js 0.5.0 の既定のフィルタは、`::ffff:127.0.0.1` で迂回できるため。ARCHITECTURE.md 5.2）
//   - ブラウザからの接続は、許可した Origin だけ
//   - 接続先のポートは、既定で 80 / 443 だけ。UDP は既定で断る
// wisp-js は WasmBox の依存パッケージではない（package.json に入れない）。使うときに `npm install --no-save` で入れる。
import http from "node:http";
import fs from "node:fs";
import { buildWispOptions, checkUpgrade, helpText, isLoopbackHost, parseRelayArgs, TESTED_WISP_VERSION } from "./relay-policy.ts";

const parsed = parseRelayArgs(process.argv.slice(2), process.env);
if (parsed.kind === "help") {
  process.stdout.write(helpText());
  process.exit(0);
}
if (parsed.kind === "error") {
  process.stderr.write(`エラー: ${parsed.message}\n`);
  process.exit(2);
}
const config = parsed.config;

let wispModule;
try {
  wispModule = await import("@mercuryworkshop/wisp-js/server");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED")) {
    process.stderr.write(
      "エラー: wisp-js が入っていません。次のコマンドで入れてから、もう一度実行してください（package.json と package-lock.json は変わりません）:\n" +
        `  npm install --no-save --package-lock=false @mercuryworkshop/wisp-js@${TESTED_WISP_VERSION}\n`,
    );
    process.exit(1);
  }
  throw error;
}
const { server: wisp, logging } = wispModule;

// 入っている wisp-js の版（package.json は exports に含まれないので、ファイルとして読む）
let installedVersion = "不明";
try {
  const entry = import.meta.resolve("@mercuryworkshop/wisp-js/server");
  installedVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", entry), "utf8")).version ?? "不明";
} catch {
  // 版が読めなくても、起動は続ける（警告だけ出す）
}

logging.set_level(logging[config.logLevel]);
for (const [key, value] of Object.entries(buildWispOptions(config))) wisp.options[key] = value;

const server = http.createServer((_request, response) => {
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("WasmBox relay: WebSocket（WISP）専用です\n");
});

server.on("clientError", (_error, socket) => socket.destroy());

server.on("upgrade", (request, socket, head) => {
  socket.on("error", () => {});
  const verdict = checkUpgrade({ url: request.url, origin: request.headers.origin }, config);
  if (!verdict.ok) {
    logging.warn(`接続を断りました: ${verdict.reason}`);
    socket.end(`HTTP/1.1 ${verdict.status} ${verdict.status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  wisp.routeRequest(request, socket, head);
});

server.on("error", (error) => {
  process.stderr.write(`エラー: ${config.host}:${config.port} で待ち受けられません（${error && typeof error === "object" && "code" in error ? String(error.code) : String(error)}）\n`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const display = config.host.includes(":") ? `[${config.host}]` : config.host;
  const lines = [
    `WasmBox リレーを起動しました: wisp://${display}:${config.port}/`,
    "  WasmBox の「ネットワーク → リレー」に、上の URL を入れてください（https のページからは、TLS のリバースプロキシで wisps:// にする必要があります: docs/relay.md）。",
    `  許可する Origin: ${config.origins.join(", ")}`,
    `  ゲストが接続できるポート: ${config.ports === null ? "制限なし" : config.ports.map((p) => (Array.isArray(p) ? `${p[0]}-${p[1]}` : String(p))).join(",")}`,
    `  UDP: ${config.allowUdp ? "許す" : "断る"}`,
    `  wisp-js: ${installedVersion}`,
  ];
  if (installedVersion !== TESTED_WISP_VERSION) {
    lines.push(`  ⚠ 確かめた版は ${TESTED_WISP_VERSION} です。版が違うと、接続先のフィルタの挙動が変わりうるので、tools/relay-check.mjs で確かめてください。`);
  }
  if (!isLoopbackHost(config.host)) {
    lines.push(`  ⚠ ${config.host} で待ち受けています。他のマシンから使われうるので、ファイアウォールと TLS のリバースプロキシで守ってください（docs/relay.md）。`);
  }
  if (config.ports === null) lines.push("  ⚠ ポートの制限がありません（SSH や SMTP などにも届きます）。");
  if (config.unsafeAllowPrivate) lines.push("  ⚠ --unsafe-allow-private: ループバックとプライベート IP に届きます。検査用です。");
  process.stdout.write(lines.join("\n") + "\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    process.stdout.write("リレーを止めます\n");
    process.exit(0);
  });
}
