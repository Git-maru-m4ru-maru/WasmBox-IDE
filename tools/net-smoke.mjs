// ゲストのネットワークを、実ブラウザ（Playwright の Chromium）+ v86 + Alpine で測る。
//
// これは「測って記録する」ための探索的なスクリプト。ゲスト内でネットワークが実際に通るかは、
// カーネルの NIC ドライバ、v86 のネットワーク実装、WISP サーバーの挙動に依存し、事前には分からないため、
// 方式ごとに「何が通って、何が通らなかったか」を、終了コード・出力・所要時間つきで GitHub Actions の
// annotation に残す。厳密に検査するのは、通常の経路（ネットワークがオフのとき）だけ。
//
// シナリオ:
//   off          … ネットワークなし。lo が上がり、DHCP を試さず（v86 は、オフでも NIC を作る）、resolv.conf が /run へのリンクであること（検査する）
//   relay-ne2k   … WISP リレー（このスクリプトが runner 上で起動する wisp-js）+ ne2k。DHCP・DNS・HTTP・HTTPS・apk・Python・Node.js
//   fetch        … ブラウザの fetch のみ（HTTP の 80 番だけ）。CORS を許可する、runner 上の HTTP サーバーへ
//   relay-virtio … WISP リレー + virtio。NIC・DHCP・HTTP だけ
//
// 前提: tools/serve.ts で site/ を http://127.0.0.1:8080/ に配信していること。
//       @mercuryworkshop/wisp-js がインストールされていること（npm install --no-save）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { failure, notice } from "./smoke-lib.mjs";

const SITE = process.env.WASMBOX_APP_URL_BASE ?? "http://127.0.0.1:8080/index.html";
const WISP_PORT = 5001;
const TARGET_PORT = 9090;
const BOOT_TIMEOUT_MS = 240_000;
const TOTAL_BUDGET_MS = Number(process.env.NET_SMOKE_BUDGET_MS ?? 20 * 60_000);
const DEADLINE = Date.now() + TOTAL_BUDGET_MS;

// ---------------------------------------------------------------------------
// runner 上の、通信先（HTTP サーバー）と WISP サーバー
// ---------------------------------------------------------------------------

/** ゲストから届いたリクエスト（通信がランナーまで届いたことの証拠になる） */
const targetRequests = [];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-private-network": "true",
};
const target = http.createServer((request, response) => {
  targetRequests.push({ method: request.method, url: request.url, host: request.headers.host, ua: request.headers["user-agent"] });
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }
  if (request.url?.startsWith("/big")) {
    response.writeHead(200, { ...CORS, "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(1024 * 1024, 0x78));
    return;
  }
  response.writeHead(200, { ...CORS, "content-type": "text/plain" });
  response.end("hello-from-runner\n");
});
await new Promise((resolve) => target.listen(TARGET_PORT, "0.0.0.0", resolve));

/** runner の、ループバックでない IPv4 アドレス（ゲストは自分の 127.0.0.1 を使ってしまうので、こちらで届ける） */
function runnerAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}
const TARGET_HOST = runnerAddress();

const wispLog = [];
// パッケージの exports に含まれないパスなので、ファイルとして直接指す
const wispCli = fileURLToPath(new URL("../node_modules/@mercuryworkshop/wisp-js/src/bin/server_cli.mjs", import.meta.url));
// wisp-js は、既定でループバックとプライベート IP への接続を拒否する。CI では runner 上の HTTP サーバー（プライベート IP）へ届けたいので許可する。
// 公開するリレーでは、許可してはいけない（README の注意を参照）。
const wisp = spawn(
  process.execPath,
  [wispCli, "-H", "127.0.0.1", "-P", String(WISP_PORT), "-L", "INFO", "-O", JSON.stringify({ allow_loopback_ips: true, allow_private_ips: true })],
  { stdio: ["ignore", "pipe", "pipe"] },
);
wisp.stdout.on("data", (chunk) => wispLog.push(String(chunk)));
wisp.stderr.on("data", (chunk) => wispLog.push(String(chunk)));

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error("WISP サーバーが起動しません: " + wispLog.join("").slice(-500));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ---------------------------------------------------------------------------
// ゲストの操作
// ---------------------------------------------------------------------------

const truncate = (text, limit) => (text.length > limit ? text.slice(0, limit) + "…(省略)" : text);

/** ターミナルの画面を、折り返しを 1 行に戻した「論理行」の配列で返す（ブラウザ側で動く関数。外の変数は使えない） */
const readLogicalLines = () => {
  const buffer = window.__wasmbox.term.buffer.active;
  const lines = [];
  let current = "";
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const next = buffer.getLine(y + 1);
    current += line.translateToString(!(next && next.isWrapped));
    if (!(next && next.isWrapped)) {
      lines.push(current.trimEnd());
      current = "";
    }
  }
  return lines;
};

async function waitForShell(page) {
  await page.waitForFunction(() => window.__wasmbox !== undefined, undefined, { timeout: BOOT_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const buffer = window.__wasmbox.term.buffer.active;
      let last = "";
      for (let y = buffer.length - 1; y >= 0; y -= 1) {
        const text = (buffer.getLine(y)?.translateToString(true) ?? "").trimEnd();
        if (text.trim() !== "") {
          last = text;
          break;
        }
      }
      return /^wasmbox:\S*[#$]$/.test(last);
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS, polling: 500 },
  );
}

const sendToGuest = (page, text) =>
  page.evaluate((value) => window.__wasmbox.engine.input(new TextEncoder().encode(value)), text);

/** ゲストにコマンドを送り、終了コードと出力を返す。時間内に終わらなければ rc = "timeout"（Ctrl-C で戻す）。 */
function makeGuest(page, steps) {
  let sequence = 0;

  async function recoverShell() {
    await sendToGuest(page, "\x03");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const id = ++sequence;
    await sendToGuest(page, `echo "__SYNC_${id}_$((1+1))"\n`);
    await page.waitForFunction(
      (pattern) => {
        const buffer = window.__wasmbox.term.buffer.active;
        for (let y = 0; y < buffer.length; y += 1) {
          if ((buffer.getLine(y)?.translateToString(true) ?? "").trimEnd() === pattern) return true;
        }
        return false;
      },
      `__SYNC_${id}_2`,
      { timeout: 20_000, polling: 250 },
    );
  }

  return async function run(name, command, { timeoutMs = 60_000, keep = 500 } = {}) {
    if (Date.now() > DEADLINE) {
      steps.push({ name, skipped: "全体の時間切れ" });
      return { rc: "skipped", out: "" };
    }
    const id = ++sequence;
    const startedAt = Date.now();
    // 開始と終了の目印を出力に挟む。コマンドの文字列自体にも目印は含まれるが、行頭からの完全一致にするので、エコーとは区別できる
    // （終了の目印は、エコーでは $rc のまま、出力では数字になる）。出力は /tmp/o.txt に集めて、先頭 3000 バイトだけ読む。
    const typed =
      `echo "__BEGIN_${id}__"; ( ${command} ) >/tmp/o.txt 2>&1; rc=$?; head -c 3000 /tmp/o.txt; echo; echo "__END_${id}_rc=\$rc"\n`;
    await sendToGuest(page, typed);
    let rc;
    try {
      await page.waitForFunction(
        (pattern) => {
          const regexp = new RegExp(pattern);
          const buffer = window.__wasmbox.term.buffer.active;
          for (let y = buffer.length - 1; y >= 0; y -= 1) {
            if (regexp.test((buffer.getLine(y)?.translateToString(true) ?? "").trimEnd())) return true;
          }
          return false;
        },
        `^__END_${id}_rc=\\d+$`,
        { timeout: timeoutMs, polling: 250 },
      );
    } catch {
      rc = "timeout";
    }
    let out = "";
    if (rc === undefined) {
      const lines = await page.evaluate(readLogicalLines);
      const begin = lines.lastIndexOf(`__BEGIN_${id}__`);
      const end = lines.findIndex((line, index) => index > begin && new RegExp(`^__END_${id}_rc=\\d+$`).test(line));
      rc = Number((lines[end] ?? "").replace(/^.*rc=/, ""));
      out = lines.slice(begin + 1, end).join("\n").trimEnd();
    }
    const step = { name, command: truncate(command, 160), rc, ms: Date.now() - startedAt, out: truncate(out, keep) };
    steps.push(step);
    console.log(`  [${name}] rc=${rc} ${step.ms}ms ${truncate(out.replace(/\n/g, " ⏎ "), 160)}`);
    if (rc === "timeout") await recoverShell();
    return { rc, out };
  };
}

const results = [];

async function scenario(browser, name, query, body) {
  console.log(`--- シナリオ: ${name}（${query}）`);
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") consoleLines.push(`${message.type()}: ${truncate(message.text(), 240)}`);
  });
  page.on("pageerror", (error) => consoleLines.push("pageerror: " + truncate(error.message, 240)));
  const steps = [];
  const result = { name, query, steps };
  results.push(result);
  const requestsBefore = targetRequests.length;
  try {
    const startedAt = Date.now();
    await page.goto(`${SITE}?smoke=1&memory=256&${query}`, { waitUntil: "load" });
    await waitForShell(page);
    result.bootSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
    await body(makeGuest(page, steps), page);
  } catch (error) {
    result.error = truncate(String(error?.message ?? error), 600);
    const lines = await page.evaluate(readLogicalLines).catch(() => []);
    result.screenTail = lines.filter((line) => line.trim() !== "").slice(-12).join("\n");
  } finally {
    result.targetRequests = targetRequests.slice(requestsBefore).slice(0, 8);
    result.console = consoleLines.slice(0, 12);
    await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/** /sys/class/net のデバイスを「名前 type=番号」で列挙する（type 1 が Ethernet、772 が lo、768 前後がトンネル） */
const NET_DEVICES = 'for d in /sys/class/net/*; do echo "${d##*/} type=$(cat $d/type)"; done';

/** 共通の、NIC・DHCP・経路・DNS・時刻の確認（探索） */
async function inspectNetwork(run) {
  await run("デバイス（名前 type）", NET_DEVICES);
  await run("wasmbox-net のログ", "cat /run/wasmbox-net.log", { keep: 900 });
  await run("dmesg（NIC 関連）", "dmesg | grep -iE 'ne2k|8390|eth[0-9]|virtio|e1000|rtl8139|pci' | head -n 14", { keep: 1200 });
  await run("アドレスと経路", "ip -4 addr show; ip route", { keep: 700 });
  await run("resolv.conf と時刻", "ls -l /etc/resolv.conf; cat /etc/resolv.conf; date -u", { keep: 500 });
}

const browser = await chromium.launch({ headless: true });
let exitCode = 0;
try {
  await waitForPort(WISP_PORT, 20_000);
  console.log(`WISP サーバー: ws://127.0.0.1:${WISP_PORT}/、通信先: http://${TARGET_HOST ?? "(アドレスなし)"}:${TARGET_PORT}/`);

  // --- off: ここだけ厳密に検査する ---
  const off = await scenario(browser, "off", "net=off", async (run) => {
    const lo = await run("lo", "ip -4 addr show lo; ip link show lo");
    assert.match(lo.out, /127\.0\.0\.1/, "lo にアドレスがありません:\n" + lo.out);
    assert.match(lo.out, /\bUP\b|LOOPBACK,UP/, "lo が上がっていません:\n" + lo.out);
    // v86 は、ネットワークがオフでも NIC（eth0）を作る（実測）。オフのときは、アドレスを取ろうとしない
    const devices = await run("デバイス（名前 type）", NET_DEVICES);
    const log = await run("wasmbox-net のログ", "cat /run/wasmbox-net.log", { keep: 400 });
    assert.match(log.out, /ネットワークはオフ/, "wasmbox-net が動いていない、またはオフを認識していません:\n" + log.out);
    const eth = await run("eth0 のアドレス（なし）", "ip -4 addr show eth0 2>&1 | grep -c inet || true");
    assert.equal(eth.out.trim(), "0", "オフなのに eth0 にアドレスがあります:\n" + devices.out);
    const cmdline = await run("コマンドライン", "cat /proc/cmdline", { keep: 300 });
    assert.doesNotMatch(cmdline.out, /wasmbox\.net=on/, "オフなのにコマンドラインに wasmbox.net=on があります");
    const link = await run("resolv.conf", "ls -l /etc/resolv.conf");
    assert.match(link.out, /-> \/run\/resolv\.conf/, "resolv.conf が /run へのリンクではありません:\n" + link.out);
    // 127.0.0.1 の待ち受けが使えること（Node.js がループバックで通信できる）
    const loopback = await run(
      "ループバックで Node.js",
      `node -e "const s=require('net').createServer(c=>c.end('pong')).listen(7777,'127.0.0.1',()=>{require('net').connect(7777,'127.0.0.1').on('data',d=>{console.log(String(d));s.close()})})"`,
      { timeoutMs: 60_000 },
    );
    assert.match(loopback.out, /pong/, "ループバックで通信できません:\n" + loopback.out);
    await run("外への通信は失敗する", "wget -T 3 -qO- http://example.com/ | head -c 100", { timeoutMs: 30_000 });
  });
  // off が失敗しても、ほかの方式の測定は続ける（最後に、失敗として報告する）
  if (off.error) {
    exitCode = 1;
    failure("WasmBox net off failure", off.error + "\n" + (off.screenTail ?? ""));
  }

  // --- relay-ne2k: WISP ---
  await scenario(browser, "relay-ne2k", `net=relay&relay=wisp://127.0.0.1:${WISP_PORT}/&nic=ne2k`, async (run) => {
    await inspectNetwork(run);
    if (TARGET_HOST) {
      const hello = await run("runner の HTTP（IP 指定）", `wget -T 15 -qO- http://${TARGET_HOST}:${TARGET_PORT}/hello`, { timeoutMs: 40_000 });
      if (hello.rc === 0) {
        await run("1 MiB の転送", `wget -T 30 -qO- http://${TARGET_HOST}:${TARGET_PORT}/big | wc -c`, { timeoutMs: 90_000 });
      }
    }
    await run("DNS（nslookup）", "nslookup example.com", { timeoutMs: 30_000, keep: 400 });
    await run("インターネットの HTTP", "wget -T 20 -qO- http://example.com/ | head -c 160", { timeoutMs: 45_000 });
    await run("インターネットの HTTPS（wget）", "wget -T 30 -qO- https://example.com/ | head -c 160", { timeoutMs: 60_000 });
    await run("apk update", "apk update", { timeoutMs: 300_000, keep: 600 });
    await run("apk add jq", "apk add --no-cache jq && jq --version", { timeoutMs: 300_000, keep: 600 });
    await run(
      "Python の HTTPS",
      `python3 -c "import urllib.request as u; print(u.urlopen('https://example.com/', timeout=60).status)"`,
      { timeoutMs: 120_000, keep: 600 },
    );
    await run("Node.js の HTTPS", `node -e "fetch('https://example.com/').then(r=>console.log(r.status),e=>{console.log('ERR',e.cause&&e.cause.code||e.message)})"`, {
      timeoutMs: 150_000,
      keep: 400,
    });
    await run("apk add npm", "apk add --no-cache npm && npm --version", { timeoutMs: 400_000, keep: 600 });
    await run("npm view", "cd /tmp && npm view is-odd version", { timeoutMs: 400_000, keep: 600 });
  });

  // --- fetch: ブラウザの fetch のみ ---
  await scenario(browser, "fetch", "net=fetch", async (run) => {
    await inspectNetwork(run);
    // N.external は、ブラウザから見た localhost:N への別名（v86 の fetch 方式）。runner 上の HTTP サーバーは CORS を許可している
    await run("localhost:N（N.external）", `wget -T 15 -qO- http://${TARGET_PORT}.external/hello`, { timeoutMs: 40_000 });
    await run("インターネットの HTTP（CORS 次第）", "wget -T 20 -qO- http://example.com/ | head -c 160", { timeoutMs: 45_000 });
    await run("HTTPS は通らないはず", "wget -T 8 -qO- https://example.com/ | head -c 100", { timeoutMs: 40_000 });
  });

  // --- relay-virtio: 軽く ---
  await scenario(browser, "relay-virtio", `net=relay&relay=wisp://127.0.0.1:${WISP_PORT}/&nic=virtio`, async (run) => {
    await inspectNetwork(run);
    await run("コマンドライン", "cat /proc/cmdline", { keep: 300 });
    if (TARGET_HOST) await run("runner の HTTP（IP 指定）", `wget -T 15 -qO- http://${TARGET_HOST}:${TARGET_PORT}/hello`, { timeoutMs: 40_000 });
  });
} catch (error) {
  exitCode = 1;
  failure("WasmBox net failure", String(error?.stack ?? error));
} finally {
  // annotation は 1 ステップあたりの件数に上限があるので、シナリオごとに 1 件にまとめる
  for (const result of results) {
    notice(`WasmBox net ${result.name}`, result);
  }
  notice("WasmBox net wisp-server", truncate(wispLog.join("").slice(-1500), 1500));
  await browser.close();
  wisp.kill("SIGTERM");
  target.close();
  process.exit(exitCode);
}
