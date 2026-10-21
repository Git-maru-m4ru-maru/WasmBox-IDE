#!/usr/bin/env node
// WISP リレーの接続先フィルタを、外から確かめる。`npm run relay:check -- wisp://127.0.0.1:5001/`
//
// 公開する前と、wisp-js の版を上げるたびに実行する（ARCHITECTURE.md 5.2 の最低限の対策の 7）。
// 内部のアドレス（ループバック・プライベート・リンクローカル・IPv4 マッピングなど）への接続を、リレーが断るかを調べる。
// これは「リレー自身のフィルタ」の検査。出口のファイアウォールで塞いでいる場合、接続は時間切れになるだけなので、
// フィルタで断っていなければ FAIL と表示する（ファイアウォールの確認は docs/relay.md の手順で、別に行う）。
import { CHECK_CASES, judgeOrigin, probeOrigin, runChecks, summarize, toWebSocketUrl } from "./relay-check-lib.ts";

const usage = `使い方: node tools/relay-check.mjs <リレーの URL> [--timeout <ミリ秒>] [--other-origin <URL>] [--json]
  例: node tools/relay-check.mjs wisp://127.0.0.1:5001/
  終了コード: 0 = 内部への迂回はすべて断られた / 1 = 断られなかったものがある / 2 = 使い方の誤り、またはリレーに接続できない
`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help") || args.length === 0) {
  process.stdout.write(usage);
  process.exit(args.length === 0 ? 2 : 0);
}

let relayUrl;
let timeoutMs = 6000;
let otherOrigin = "https://other-site.invalid";
let asJson = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--timeout") {
    timeoutMs = Number(args[(i += 1)]);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 500) {
      process.stderr.write("エラー: --timeout は 500 以上のミリ秒です\n");
      process.exit(2);
    }
  } else if (arg === "--other-origin") {
    otherOrigin = args[(i += 1)] ?? "";
  } else if (arg === "--json") {
    asJson = true;
  } else if (arg !== undefined && !arg.startsWith("--") && relayUrl === undefined) {
    relayUrl = arg;
  } else {
    process.stderr.write(`エラー: 分からない引数です: ${String(arg)}\n${usage}`);
    process.exit(2);
  }
}

let wsUrl;
try {
  wsUrl = toWebSocketUrl(relayUrl ?? "");
} catch (error) {
  process.stderr.write(`エラー: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const results = await runChecks(wsUrl, CHECK_CASES, { timeoutMs });

// リレーに話しかけられなかった（全部 error）ときは、検査になっていない
const reachable = results.some((r) => r.outcome.verdict !== "error");
if (!reachable) {
  process.stderr.write(`エラー: リレーと WISP で話せませんでした（${wsUrl}）。起動しているか、URL が合っているかを確かめてください。\n  例: ${results[0]?.outcome.detail ?? ""}\n`);
  process.exit(2);
}

const origin = await probeOrigin(wsUrl, otherOrigin, timeoutMs);
const originJudgement = judgeOrigin(origin);

const judgements = [...results.map((r) => r.judgement), originJudgement];
const summary = summarize(judgements);

if (asJson) {
  process.stdout.write(
    JSON.stringify({
      relay: wsUrl,
      summary,
      cases: results.map((r) => ({ id: r.case.id, level: r.case.level, host: r.case.host, port: r.case.port, verdict: r.outcome.verdict, detail: r.outcome.detail, judgement: r.judgement })),
      origin: { origin: otherOrigin, status: origin.status ?? null, judgement: originJudgement },
    }) + "\n",
  );
} else {
  const mark = { ok: "✅", fail: "❌", warn: "⚠️ ", info: "ℹ️ " };
  const levelName = { required: "必須", recommended: "推奨", info: "参考" };
  process.stdout.write(`リレー: ${wsUrl}\n\n`);
  for (const r of results) {
    const target = `${r.case.type === 2 ? "udp:" : ""}${r.case.host}:${r.case.port}`;
    process.stdout.write(`${mark[r.judgement]} [${levelName[r.case.level]}] ${r.case.label}  ${target}  → ${r.outcome.verdict}（${r.outcome.detail}）\n`);
  }
  process.stdout.write(`${mark[originJudgement]} [推奨] 他のサイトの Origin（${otherOrigin}）を断るか  → ${origin.detail}\n`);
  process.stdout.write(`\n合計: ✅ ${summary.ok}  ❌ ${summary.fail}  ⚠️  ${summary.warn}  ℹ️  ${summary.info}\n`);
  if (summary.fail > 0) {
    process.stdout.write("❌ があります。このリレーは、内部のアドレスへの接続を断りきれていません。公開してはいけません（docs/relay.md）。\n");
  } else {
    process.stdout.write("必須の項目は、すべて断られました。これは、リレー自身のフィルタの確認です。出口のファイアウォールの確認は、別に行ってください。\n");
  }
}
process.exit(summary.exitCode);
