// 実物の wisp-js をつないで、tools/relay.mjs の接続先フィルタが効くことを確かめる。
// wisp-js は WasmBox の依存パッケージではないので、入っていなければ、この中の大半はスキップされる:
//   npm install --no-save --package-lock=false @mercuryworkshop/wisp-js@0.5.0
// 見張り役（canary）の TCP サーバーをこのマシンの内側に置き、リレー越しに届いてしまうかどうかで確かめる。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECK_CASES, probeConnect, probeOrigin, runChecks, summarize, judgeOrigin } from "../tools/relay-check-lib.ts";

const relayScript = fileURLToPath(new URL("../tools/relay.mjs", import.meta.url));

/** 依存パッケージではないので、型の解決に頼らず、名前で読み込む（入っていなければ、スキップする） */
const WISP_MODULE = "@mercuryworkshop/wisp-js/server";
interface WispServerModule {
  server: { routeRequest: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void };
  logging: { set_level: (level: number) => void; NONE: number };
}

let wispInstalled = true;
try {
  await import(WISP_MODULE);
} catch {
  wispInstalled = false;
}
const skipWithoutWisp = wispInstalled ? false : "wisp-js が入っていないので、スキップ（npm install --no-save --package-lock=false @mercuryworkshop/wisp-js@0.5.0）";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function privateAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}

interface Canary {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

/** 接続されたら、名前を返してすぐ閉じる TCP サーバー（全アドレスで待ち受ける）。何件接続されたかを数える */
async function startCanary(): Promise<Canary> {
  let count = 0;
  const server = net.createServer((socket) => {
    count += 1;
    socket.on("error", () => {});
    socket.end("CANARY\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, connections: () => count, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface Relay {
  wsUrl: string;
  log: () => string;
  stop: () => Promise<void>;
}

async function waitForPort(port: number, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`リレーが終了しました（${String(child.exitCode)}）: ${log()}`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`リレーが起動しません: ${log()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startRelay(args: string[]): Promise<Relay> {
  const port = await freePort();
  const child = spawn(process.execPath, [relayScript, "--port", String(port), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: string[] = [];
  child.stdout.on("data", (d) => chunks.push(String(d)));
  child.stderr.on("data", (d) => chunks.push(String(d)));
  const log = (): string => chunks.join("").slice(-1500);
  await waitForPort(port, child, log);
  return {
    wsUrl: `ws://127.0.0.1:${port}/`,
    log,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

const text = (data: Uint8Array | undefined): string => (data ? new TextDecoder().decode(data) : "");

describe("relay.mjs の引数（wisp-js なしで確かめられる部分）", () => {
  const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [relayScript, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: string[] = [];
      child.stdout.on("data", (d) => chunks.push(String(d)));
      child.stderr.on("data", (d) => chunks.push(String(d)));
      child.on("exit", (code) => resolve({ code, out: chunks.join("") }));
    });

  it("--help は、説明を出して終了コード 0", async () => {
    const result = await run(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /--origin/);
    assert.match(result.out, /npm install --no-save/);
  });

  it("不正な引数は、理由を出して終了コード 2（待ち受けを始めない）", async () => {
    const result = await run(["--origin", "*"]);
    assert.equal(result.code, 2);
    assert.match(result.out, /ワイルドカード/);
  });

  it("wisp-js が入っていなければ、入れ方を示して終了コード 1", { skip: wispInstalled ? "wisp-js が入っているので、スキップ" : false }, async () => {
    const result = await run([]);
    assert.equal(result.code, 1);
    assert.match(result.out, /npm install --no-save --package-lock=false @mercuryworkshop\/wisp-js@0\.5\.0/);
  });
});

describe("relay.mjs（既定の方針）", { skip: skipWithoutWisp }, () => {
  let canary: Canary;
  let relay: Relay;
  const privateIp = privateAddress();

  before(async () => {
    canary = await startCanary();
    // ポートは制限しない（見張り役のポートで、IP の方針だけを確かめるため。ポートの制限で断られて、成功に見えないように）
    relay = await startRelay(["--ports", "all"]);
  });
  after(async () => {
    await relay.stop();
    await canary.close();
  });

  it("内部への迂回（ループバック・IPv4 マッピング・プライベート）は、見張り役に届かない", async () => {
    const hosts = ["127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "localhost", "127.1", ...(privateIp ? [privateIp, `::ffff:${privateIp}`] : [])];
    for (const host of hosts) {
      const outcome = await probeConnect(relay.wsUrl, { host, port: canary.port, type: 1 }, { timeoutMs: 4000 });
      assert.equal(outcome.verdict, "blocked", `${host}: ${outcome.detail}\n${relay.log()}`);
    }
    assert.equal(canary.connections(), 0, "見張り役に接続が届いた");
  });

  it("relay-check の必須の項目は、すべて断られる（失敗 0）", async () => {
    const results = await runChecks(relay.wsUrl, CHECK_CASES, { timeoutMs: 4000 });
    const failed = results.filter((r) => r.judgement === "fail").map((r) => `${r.case.id}: ${r.outcome.detail}`);
    assert.deepEqual(failed, []);
    const origin = await probeOrigin(relay.wsUrl, "https://other-site.invalid");
    assert.equal(judgeOrigin(origin), "ok");
    assert.equal(summarize([...results.map((r) => r.judgement), judgeOrigin(origin)]).exitCode, 0);
  });

  it("名前（example.com）と、IPv6 の公開アドレスは、v86 が送らない形なので断る", async () => {
    for (const host of ["example.com", "2606:4700:4700::1111"]) {
      const outcome = await probeConnect(relay.wsUrl, { host, port: 80, type: 1 }, { timeoutMs: 4000 });
      assert.equal(outcome.verdict, "blocked", host);
    }
  });

  it("許可した Origin（既定の localhost:8080）は通り、他のサイトの Origin は 403", async () => {
    assert.equal((await probeOrigin(relay.wsUrl, "http://localhost:8080")).status, 101);
    assert.equal((await probeOrigin(relay.wsUrl, "http://127.0.0.1:8080")).status, 101);
    assert.equal((await probeOrigin(relay.wsUrl, "https://evil.example")).status, 403);
    assert.equal((await probeOrigin(relay.wsUrl, "null")).status, 403);
  });

  it("wsproxy の形のパスは 404（WISP のパス以外は使わせない）", async () => {
    const status = await new Promise<number | undefined>((resolve) => {
      const request = http.request(relay.wsUrl.replace("ws://", "http://") + "1.1.1.1:80", {
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode);
        request.destroy();
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on("error", () => resolve(undefined));
      request.end();
    });
    assert.equal(status, 404);
  });
});

describe("relay.mjs のポートと UDP の制限", { skip: skipWithoutWisp }, () => {
  let strict: Relay;
  let open: Relay;

  before(async () => {
    strict = await startRelay([]);
    open = await startRelay(["--ports", "all", "--allow-udp"]);
  });
  after(async () => {
    await strict.stop();
    await open.stop();
  });

  // 公開 IP（1.1.1.1）への接続は、ここでは実際には届かなくてよい。「フィルタが断ったか、通したか」だけを見る
  const probe = (relay: Relay, port: number, type: 1 | 2) => probeConnect(relay.wsUrl, { host: "1.1.1.1", port, type }, { timeoutMs: 1500 });

  it("既定は、80 と 443 だけ。25・22・8080 と UDP は断る", async () => {
    for (const port of [25, 22, 8080, 53]) assert.equal((await probe(strict, port, 1)).verdict, "blocked", `tcp ${String(port)}`);
    assert.equal((await probe(strict, 53, 2)).verdict, "blocked", "udp 53");
    for (const port of [80, 443]) assert.equal((await probe(strict, port, 1)).verdict, "passed", `tcp ${String(port)}`);
  });

  it("--ports all と --allow-udp で、断らなくなる", async () => {
    assert.equal((await probe(open, 25, 1)).verdict, "passed");
    assert.equal((await probe(open, 53, 2)).verdict, "passed");
  });

  it("--ports all でも、内部への迂回は断る（ポートの制限に頼っていない）", async () => {
    for (const host of ["127.0.0.1", "::ffff:127.0.0.1", "169.254.169.254"]) {
      const outcome = await probeConnect(open.wsUrl, { host, port: 25, type: 1 }, { timeoutMs: 1500 });
      assert.equal(outcome.verdict, "blocked", host);
    }
  });
});

describe("relay.mjs --unsafe-allow-private（検査用）", { skip: skipWithoutWisp }, () => {
  let canary: Canary;
  let relay: Relay;

  before(async () => {
    canary = await startCanary();
    relay = await startRelay(["--ports", "all", "--unsafe-allow-private"]);
  });
  after(async () => {
    await relay.stop();
    await canary.close();
  });

  it("IPv4 のループバックには届く（見張り役が応答する）。IPv4 マッピングの表記は、それでも断る", async () => {
    const reached = await probeConnect(relay.wsUrl, { host: "127.0.0.1", port: canary.port, type: 1 }, { timeoutMs: 4000 });
    assert.equal(reached.verdict, "passed", reached.detail);
    assert.equal(text(reached.data), "CANARY\n");
    const seen = canary.connections();
    for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      const outcome = await probeConnect(relay.wsUrl, { host, port: canary.port, type: 1 }, { timeoutMs: 4000 });
      assert.equal(outcome.verdict, "blocked", host);
    }
    assert.equal(canary.connections(), seen);
  });
});

describe("wisp-js の既定のまま（対照。このリポジトリの方針を入れない場合）", { skip: skipWithoutWisp }, () => {
  let canary: Canary;
  let server: http.Server;
  let wsUrl = "";

  before(async () => {
    canary = await startCanary();
    const wispModule: WispServerModule = await import(WISP_MODULE);
    wispModule.logging.set_level(wispModule.logging.NONE);
    server = http.createServer((_request, response) => response.end("x"));
    server.on("upgrade", (request, socket, head) => wispModule.server.routeRequest(request, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    wsUrl = `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await canary.close();
  });

  it("IPv4 のループバックは断る（ここは既定でも効く）", async () => {
    const outcome = await probeConnect(wsUrl, { host: "127.0.0.1", port: canary.port, type: 1 }, { timeoutMs: 4000 });
    assert.equal(outcome.verdict, "blocked");
  });

  it("IPv4 マッピングの表記は、フィルタを通過する（0.5.0 の実測。ARCHITECTURE.md 5.2）。relay-check はこれを失敗にする", async () => {
    const outcome = await probeConnect(wsUrl, { host: "::ffff:127.0.0.1", port: canary.port, type: 1 }, { timeoutMs: 4000 });
    // 断られない（= フィルタを通過した）ことが、迂回の本体。見張り役に届くかは、IPv6 が使えるマシンかにもよるので、ここでは見ない
    assert.notEqual(outcome.verdict, "blocked", outcome.detail);
    const results = await runChecks(wsUrl, CHECK_CASES, { timeoutMs: 3000 });
    const failed = results.filter((r) => r.judgement === "fail").map((r) => r.case.id);
    assert.ok(failed.includes("mapped-loopback"), `失敗した項目: ${failed.join(",")}`);
    assert.equal(summarize(results.map((r) => r.judgement)).exitCode, 1);
  });
});
