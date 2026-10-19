// 【一時的な調査。結果を記録したら、このファイルと .github/workflows/probe.yml は削除する】
// wisp-js 0.5.0 のサーバーを「既定の設定」で起動し、公開リレーに必要な接続先のフィルタが、実際に効くかを確かめる。
// 通信先は、このスクリプトが runner 上に立てる、バナーを返すだけのダミーの TCP サーバーと、example.com だけ。
// WISP v1 のパケット: [種類 u8][ストリーム ID u32 LE][本体]。CONNECT=0x01（種類 u8, ポート u16 LE, ホスト名）, DATA=0x02, CONTINUE=0x03, CLOSE=0x04（理由 u8）
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const wispCli = fileURLToPath(new URL("../node_modules/@mercuryworkshop/wisp-js/src/bin/server_cli.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
const out = (text) => {
  lines.push(text);
  console.log(text);
};

// --- ダミーの通信先（接続されたら、すぐに名前を返す）---
const targets = [];
function banner(name, port, host) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end(`TARGET-${name}\n`);
    });
    server.on("error", (error) => {
      out(`(ダミーの通信先 ${name} を立てられません: ${error.code})`);
      resolve(false);
    });
    server.listen(port, host, () => {
      targets.push(server);
      resolve(true);
    });
  });
}
await banner("LOOPBACK4", 9090, "127.0.0.1");
await banner("ANY4", 9091, "0.0.0.0");
const hasV6 = await banner("LOOPBACK6", 9092, "::1");
await banner("DUALSTACK", 9093, "::");

function runnerAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}
const PRIVATE_IP = runnerAddress();
out(`runner の IPv4: ${PRIVATE_IP}  IPv6 ループバックのダミー: ${hasV6}`);

// --- WISP サーバーの起動 ---
const servers = [];
async function startServer(port, options) {
  const args = [wispCli, "-H", "127.0.0.1", "-P", String(port), "-L", "INFO"];
  if (options) args.push("-O", JSON.stringify(options));
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  servers.push({ child, log, port });
  for (let i = 0; i < 80; i += 1) {
    const open = await new Promise((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => (s.destroy(), resolve(true)));
      s.on("error", () => resolve(false));
    });
    if (open) return log;
    await sleep(250);
  }
  out(`(WISP サーバー ${port} が起動しません: ${log.join("").slice(-300)})`);
  return log;
}

const printable = (buf) => buf.toString("latin1").replace(/[^\x20-\x7e]/g, ".").slice(0, 40);

/** 1 つの接続先を試して、結果を 1 行の文字列で返す */
function probe(port, host, targetPort, { origin, timeoutMs = 7000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { headers: { Origin: origin } } : undefined);
    let sent = false;
    let done = false;
    const seen = [];
    const finish = (verdict) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {}
      resolve(verdict);
    };
    const timer = setTimeout(() => finish(`timeout（受信: ${seen.join(",") || "なし"}。フィルタを通過して接続待ち、の可能性）`), timeoutMs);
    const connect = () => {
      if (sent) return;
      sent = true;
      const name = Buffer.from(host, "utf8");
      const body = Buffer.alloc(1 + 4 + 1 + 2 + name.length);
      body.writeUInt8(0x01, 0);
      body.writeUInt32LE(1, 1);
      body.writeUInt8(0x01, 5);
      body.writeUInt16LE(targetPort, 6);
      name.copy(body, 8);
      ws.send(body);
      const request = Buffer.from(`GET / HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
      const data = Buffer.alloc(5 + request.length);
      data.writeUInt8(0x02, 0);
      data.writeUInt32LE(1, 1);
      request.copy(data, 5);
      ws.send(data);
    };
    ws.on("open", () => setTimeout(connect, 700));
    ws.on("error", (error) => finish(`ws-error ${error.message}`));
    ws.on("close", () => finish("ws-closed（サーバーが接続ごと閉じた）"));
    ws.on("message", (raw) => {
      const buf = Buffer.from(raw);
      const type = buf[0];
      const id = buf.readUInt32LE(1);
      seen.push(`0x${type.toString(16)}/s${id}`);
      if (type === 0x03 && id === 0) connect();
      else if (type === 0x04 && id === 1) finish(`CLOSE reason=0x${buf[5].toString(16)}`);
      else if (type === 0x02 && id === 1) finish(`DATA "${printable(buf.subarray(5))}"`);
    });
  });
}

async function runCases(title, port, cases) {
  out(`\n### ${title}`);
  const results = await Promise.all(cases.map(([label, host, targetPort, opts]) => probe(port, host, targetPort, opts)));
  cases.forEach(([label, host, targetPort], i) => out(`${label} (${host}:${targetPort}) → ${results[i]}`));
}

try {
  await startServer(5001, undefined); // 既定の設定
  const exampleIps = await dns.resolve4("example.com").catch(() => []);
  const cases = [
    ["A ループバック（IP）", "127.0.0.1", 9090],
    ["B localhost", "localhost", 9090],
    ["C 0.0.0.0", "0.0.0.0", 9091],
    ["D IPv4 マッピング（ループバック）", "::ffff:127.0.0.1", 9090],
    ["E IPv4 マッピング（16 進）", "::ffff:7f00:1", 9090],
    ["F 127.1", "127.1", 9090],
    ["G 10 進", "2130706433", 9090],
    ["H 16 進", "0x7f000001", 9090],
    ["I 8 進", "0177.0.0.1", 9090],
    ["J IPv6 ループバック", "::1", 9092],
    ["K runner のプライベート IP", PRIVATE_IP ?? "10.255.255.1", 9091],
    ["L IPv4 マッピング（プライベート）", `::ffff:${PRIVATE_IP ?? "10.255.255.1"}`, 9091],
    ["M リンクローカル（169.254.1.1）", "169.254.1.1", 80, { timeoutMs: 5000 }],
    ["N CGNAT（100.64.0.1）", "100.64.0.1", 80, { timeoutMs: 5000 }],
    ["O IPv6 ULA（fd00::1）", "fd00::1", 80, { timeoutMs: 5000 }],
    ["P ブロードキャスト", "255.255.255.255", 80, { timeoutMs: 5000 }],
    ["Q ループバックに解決されるドメイン（localtest.me）", "localtest.me", 9090],
    ["R 公開サーバー（基準。通るはず）", "example.com", 80],
    ["S 公開サーバー + 他サイトの Origin", "example.com", 80, { origin: "https://evil.example" }],
    ["T デュアルスタックへ（::ffff:127.0.0.1）", "::ffff:127.0.0.1", 9093],
  ];
  // 同時に走らせすぎない（4 つずつ）
  for (let i = 0; i < cases.length; i += 5) await runCases(i === 0 ? "既定の設定（5001）" : `（続き ${i / 5 + 1}）`, 5001, cases.slice(i, i + 5));

  await startServer(5002, { port_whitelist: [80, 443] });
  await runCases("port_whitelist: [80, 443]（5002）", 5002, [
    ["U example.com:80", "example.com", 80],
    ["V example.com:25", "example.com", 25, { timeoutMs: 5000 }],
    ["W example.com:8080", "example.com", 8080, { timeoutMs: 5000 }],
  ]);

  await startServer(5003, { hostname_whitelist: ["^example\\.com$"] });
  await runCases("hostname_whitelist: [^example\\.com$]（5003）", 5003, [
    ["X ドメインで接続", "example.com", 80],
    ["Y 同じサーバーを IP で接続（v86 はこの形で接続している）", exampleIps[0] ?? "93.184.215.14", 80, { timeoutMs: 5000 }],
  ]);

  await startServer(5004, { allow_direct_ip: false });
  await runCases("allow_direct_ip: false（5004）", 5004, [
    ["Z ドメインで接続", "example.com", 80],
    ["Z2 IP で接続", exampleIps[0] ?? "93.184.215.14", 80, { timeoutMs: 5000 }],
  ]);
} catch (error) {
  out(`調査が例外で止まりました: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  for (const { child, log, port } of servers) {
    const tail = log.join("").split("\n").filter((l) => /error|warn|invalid|block|config/i.test(l)).slice(0, 4).join(" | ");
    if (tail) out(`サーバー ${port} のログ（抜粋）: ${tail.slice(0, 300)}`);
    child.kill("SIGTERM");
  }
  for (const t of targets) t.close();
  // 注釈は 3000 バイトずつに分ける
  let chunk = "";
  const chunks = [];
  for (const line of lines) {
    if (Buffer.byteLength(chunk + line) > 2800) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  chunks.push(chunk);
  chunks.forEach((c, i) => console.log(`::notice title=probe relay filter (${i + 1}/${chunks.length})::${c.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`));
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
}
