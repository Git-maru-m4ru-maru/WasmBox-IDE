import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// ゲストのネットワーク初期化スクリプト（image/wasmbox-net、image/wasmbox-udhcpc-script）の振る舞いを、
// ip / udhcpc / date を、呼ばれ方を記録する偽物に差し替えて確かめる。
// 実際の busybox・カーネルでの動作は、ここでは確かめていない（CI の tools/net-smoke.mjs で確かめる）。
// シェルは、この環境の sh（dash など）。POSIX の範囲で書いてあるので、busybox の ash でも動く想定。

const NET_SCRIPT = fileURLToPath(new URL("../image/wasmbox-net", import.meta.url));
const UDHCPC_SCRIPT = fileURLToPath(new URL("../image/wasmbox-udhcpc-script", import.meta.url));

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "wasmbox-image-net-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Sandbox {
  dir: string;
  sysNet: string;
  log: string;
  resolv: string;
  /** 偽の ip / udhcpc が、呼ばれた引数を 1 行ずつ追記するファイル */
  calls: string;
  env: Record<string, string>;
}

/** 偽の ip と udhcpc を PATH の先頭に置いた、使い捨ての環境を作る。udhcpcExit は、偽の udhcpc の終了コード。 */
async function makeSandbox(options: { nics: string[]; udhcpcExit?: number }): Promise<Sandbox> {
  const dir = join(root, String(counter++));
  const bin = join(dir, "bin");
  const sysNet = join(dir, "sys-net");
  await mkdir(bin, { recursive: true });
  await mkdir(sysNet, { recursive: true });
  for (const nic of ["lo", ...options.nics]) await mkdir(join(sysNet, nic));
  const calls = join(dir, "calls.txt");
  await writeFile(calls, "");
  for (const name of ["ip", "udhcpc", "date"]) {
    const exit = name === "udhcpc" ? (options.udhcpcExit ?? 0) : 0;
    // 偽のコマンドは、標準出力と標準エラーにも出力する（スクリプトがそれをコンソールに漏らさないことを確かめるため）
    await writeFile(
      join(bin, name),
      `#!/bin/sh\necho "${name} $*" >> "${calls}"\necho "${name}: out"\necho "${name}: err" >&2\nexit ${exit}\n`,
    );
    await chmod(join(bin, name), 0o755);
  }
  const log = join(dir, "net.log");
  const resolv = join(dir, "resolv.conf");
  return {
    dir,
    sysNet,
    log,
    resolv,
    calls,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      WASMBOX_NET_LOG: log,
      WASMBOX_SYS_NET: sysNet,
      WASMBOX_UDHCPC_SCRIPT: "/fake/udhcpc-script",
      WASMBOX_RESOLV_CONF: resolv,
    },
  };
}

const run = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync("sh", [script, ...args], { env, encoding: "utf8" });

const callsOf = async (sandbox: Sandbox) => (await readFile(sandbox.calls, "utf8")).split("\n").filter(Boolean);

describe("image/wasmbox-net（起動時のネットワーク初期化）", () => {
  it("NIC がなくても、lo は上げる。DHCP は試さない。コンソールには何も出さない", async () => {
    const sandbox = await makeSandbox({ nics: [] });
    const result = run(NET_SCRIPT, [], sandbox.env);
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, "", "標準出力・標準エラーには何も出さない（シリアルを汚さない）");
    const calls = await callsOf(sandbox);
    assert.ok(calls.includes("ip link set lo up"), calls.join("\n"));
    assert.ok(!calls.some((call) => call.startsWith("udhcpc")), "NIC がないのに DHCP を試した");
    assert.match(await readFile(sandbox.log, "utf8"), /NIC なし/);
  });

  it("lo 以外の NIC があれば、上げて、その NIC に DHCP を試す。lo には DHCP を試さない", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"] });
    const result = run(NET_SCRIPT, [], sandbox.env);
    assert.equal(result.status, 0);
    const calls = await callsOf(sandbox);
    assert.ok(calls.includes("ip link set eth0 up"), calls.join("\n"));
    const dhcp = calls.filter((call) => call.startsWith("udhcpc"));
    assert.equal(dhcp.length, 1, calls.join("\n"));
    assert.match(dhcp[0] ?? "", /^udhcpc -i eth0 -s \/fake\/udhcpc-script /);
    assert.match(await readFile(sandbox.log, "utf8"), /DHCP 成功: eth0/);
  });

  it("DHCP に失敗しても、スクリプトは正常に終わり、失敗をログに残す（起動を止めない）", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"], udhcpcExit: 1 });
    const result = run(NET_SCRIPT, [], sandbox.env);
    assert.equal(result.status, 0);
    assert.match(await readFile(sandbox.log, "utf8"), /DHCP 失敗: eth0/);
  });

  it("NIC が複数あれば、それぞれに DHCP を試す", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0", "eth1"] });
    run(NET_SCRIPT, [], sandbox.env);
    const dhcp = (await callsOf(sandbox)).filter((call) => call.startsWith("udhcpc"));
    assert.equal(dhcp.length, 2);
  });
});

describe("image/wasmbox-udhcpc-script（DHCP で得た設定を反映する）", () => {
  const lease = (sandbox: Sandbox, extra: Record<string, string> = {}) => ({
    ...sandbox.env,
    interface: "eth0",
    ip: "192.168.86.100",
    mask: "24",
    router: "192.168.86.1",
    dns: "192.168.86.1 1.1.1.1",
    domain: "example.test",
    ...extra,
  });

  it("bound: アドレスと既定経路を設定し、resolv.conf を書く", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"] });
    const result = run(UDHCPC_SCRIPT, ["bound"], lease(sandbox));
    assert.equal(result.status, 0);
    const calls = await callsOf(sandbox);
    assert.deepEqual(calls, [
      "ip addr flush dev eth0",
      "ip addr add 192.168.86.100/24 brd + dev eth0",
      "ip route add default via 192.168.86.1 dev eth0",
    ]);
    assert.equal(
      await readFile(sandbox.resolv, "utf8"),
      "search example.test\nnameserver 192.168.86.1\nnameserver 1.1.1.1\n",
    );
  });

  it("renew も bound と同じ。ドメインがなければ search 行は書かない。mask がなければ /24", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"] });
    run(UDHCPC_SCRIPT, ["renew"], lease(sandbox, { domain: "", mask: "", dns: "9.9.9.9" }));
    const calls = await callsOf(sandbox);
    assert.ok(calls.includes("ip addr add 192.168.86.100/24 brd + dev eth0"), calls.join("\n"));
    assert.equal(await readFile(sandbox.resolv, "utf8"), "nameserver 9.9.9.9\n");
  });

  it("ルーターが複数あれば、最初に成功したものだけを既定経路にする", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"] });
    run(UDHCPC_SCRIPT, ["bound"], lease(sandbox, { router: "10.0.0.1 10.0.0.2" }));
    const routes = (await callsOf(sandbox)).filter((call) => call.startsWith("ip route"));
    assert.deepEqual(routes, ["ip route add default via 10.0.0.1 dev eth0"]);
  });

  it("deconfig: アドレスを消してリンクを上げる。resolv.conf には触らない", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"] });
    run(UDHCPC_SCRIPT, ["deconfig"], lease(sandbox));
    assert.deepEqual(await callsOf(sandbox), ["ip addr flush dev eth0", "ip link set eth0 up"]);
    await assert.rejects(readFile(sandbox.resolv, "utf8"), { code: "ENOENT" });
  });

  it("nak・leasefail などの、知らないイベントでは何もしない", async () => {
    const sandbox = await makeSandbox({ nics: ["eth0"] });
    for (const event of ["nak", "leasefail", "ifup"]) {
      assert.equal(run(UDHCPC_SCRIPT, [event], lease(sandbox)).status, 0);
    }
    assert.deepEqual(await callsOf(sandbox), []);
  });
});
