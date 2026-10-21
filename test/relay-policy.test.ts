import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWispOptions,
  checkUpgrade,
  DEFAULT_ORIGINS,
  DEFAULT_PORT,
  IPV4_LITERAL,
  isLoopbackHost,
  normalizeOrigin,
  parsePortRules,
  parseRelayArgs,
  STREAM_LIMIT_TOTAL,
} from "../tools/relay-policy.ts";
import type { RelayConfig } from "../tools/relay-policy.ts";

function runConfig(argv: string[], env: Record<string, string | undefined> = {}): RelayConfig {
  const parsed = parseRelayArgs(argv, env);
  assert.equal(parsed.kind, "run", JSON.stringify(parsed));
  if (parsed.kind !== "run") throw new Error("unreachable");
  return parsed.config;
}

describe("IPV4_LITERAL（接続先として許す書き方）", () => {
  it("正規形のドット区切りの IPv4 だけを許す", () => {
    for (const ok of ["1.1.1.1", "93.184.216.34", "0.0.0.0", "255.255.255.255", "10.0.0.1", "192.168.86.1", "100.64.0.1"]) {
      assert.ok(IPV4_LITERAL.test(ok), ok);
    }
  });

  it("IPv6（IPv4 マッピングを含む）・名前・別表記の IPv4 は許さない", () => {
    const rejected = [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::1",
      "fd00::1",
      "2001:db8::1",
      "localhost",
      "example.com",
      "127.1", // 短縮
      "2130706433", // 10 進
      "0x7f.0.0.1", // 16 進
      "0177.0.0.1", // 8 進（先頭の 0）
      "017.0.0.1",
      "127.00.0.1",
      "01.1.1.1", // 先頭の 0（どの桁でも）
      "1.01.1.1",
      "1.1.01.1",
      "1.1.1.01",
      "00.0.0.0",
      "08.8.8.8",
      "1.1.1.001",
      "256.1.1.1",
      "1.1.1",
      "1.1.1.1.1",
      "1.1.1.1 ",
      " 1.1.1.1",
      "1.1.1.1\n",
      "1.1.1.1:80",
      "",
    ];
    for (const bad of rejected) assert.equal(IPV4_LITERAL.test(bad), false, JSON.stringify(bad));
  });
});

describe("parsePortRules", () => {
  it("単独のポートと範囲を読む", () => {
    assert.deepEqual(parsePortRules("80,443,8000-8100"), { ok: true, value: [80, 443, [8000, 8100]] });
    assert.deepEqual(parsePortRules(" 80 , 443 "), { ok: true, value: [80, 443] });
  });

  it("all は制限なし（null）", () => {
    assert.deepEqual(parsePortRules("all"), { ok: true, value: null });
    assert.deepEqual(parsePortRules("ALL"), { ok: true, value: null });
  });

  it("不正な指定は、理由つきで断る", () => {
    for (const bad of ["", "0", "65536", "80,", "abc", "443-80", "80-", "-80", "80;443", "1e3"]) {
      const result = parsePortRules(bad);
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
    const range = parsePortRules("443-80");
    assert.ok(!range.ok && /始まりが終わりより大きい/.test(range.message));
  });
});

describe("normalizeOrigin", () => {
  it("http / https の、サイトの頭の部分だけを受け付ける（正規の形にして返す）", () => {
    assert.deepEqual(normalizeOrigin("https://example.com"), { ok: true, value: "https://example.com" });
    assert.deepEqual(normalizeOrigin("https://EXAMPLE.com/"), { ok: true, value: "https://example.com" });
    assert.deepEqual(normalizeOrigin("http://localhost:8080"), { ok: true, value: "http://localhost:8080" });
    assert.deepEqual(normalizeOrigin("https://example.com:443"), { ok: true, value: "https://example.com" });
  });

  it("ワイルドカード・パス・認証情報・別のスキームは断る", () => {
    for (const bad of ["*", "https://*.example.com", "https://example.com/app", "https://example.com?x=1", "https://u:p@example.com", "ftp://example.com", "example.com", "", "null"]) {
      assert.equal(normalizeOrigin(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("isLoopbackHost", () => {
  it("ループバックだけを true にする", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("::"), false);
    assert.equal(isLoopbackHost("192.168.1.2"), false);
  });
});

describe("parseRelayArgs", () => {
  it("引数なしは、安全な既定（127.0.0.1:5001、80/443 だけ、UDP なし、既定の Origin）", () => {
    const config = runConfig([]);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, DEFAULT_PORT);
    assert.deepEqual(config.ports, [80, 443]);
    assert.equal(config.allowUdp, false);
    assert.equal(config.unsafeAllowPrivate, false);
    assert.deepEqual(config.origins, [...DEFAULT_ORIGINS]);
    assert.equal(config.logLevel, "INFO");
  });

  it("--help は help。-h も同じ", () => {
    assert.equal(parseRelayArgs(["--help"]).kind, "help");
    assert.equal(parseRelayArgs(["--port", "1", "-h"]).kind, "help");
  });

  it("--port と PORT。引数が優先", () => {
    assert.equal(runConfig([], { PORT: "7000" }).port, 7000);
    assert.equal(runConfig(["--port", "7100"], { PORT: "7000" }).port, 7100);
    assert.equal(runConfig(["--port=7200"]).port, 7200);
  });

  it("--origin は何度でも・カンマ区切りでも指定でき、指定すると既定の Origin は使わない", () => {
    const config = runConfig(["--origin", "https://a.example", "--origin=https://b.example,https://c.example", "--origin", "https://a.example/"]);
    assert.deepEqual(config.origins, ["https://a.example", "https://b.example", "https://c.example"]);
  });

  it("--ports / --allow-udp / --log / --host / --unsafe-allow-private", () => {
    const config = runConfig(["--ports", "80,443,22", "--allow-udp", "--log", "warn", "--host", "0.0.0.0", "--unsafe-allow-private"]);
    assert.deepEqual(config.ports, [80, 443, 22]);
    assert.equal(config.allowUdp, true);
    assert.equal(config.logLevel, "WARN");
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.unsafeAllowPrivate, true);
    assert.equal(runConfig(["--ports", "all"]).ports, null);
  });

  it("不正な指定は error（黙って既定に戻さない）", () => {
    const cases: string[][] = [
      ["--bogus"],
      ["--port"],
      ["--port", "abc"],
      ["--port", "0"],
      ["--port", "70000"],
      ["--origin", "*"],
      ["--origin", "https://example.com/path"],
      ["--ports", "abc"],
      ["--ports"],
      ["--log", "LOUD"],
      ["--host"],
      ["--host="],
      ["80"],
    ];
    for (const argv of cases) assert.equal(parseRelayArgs(argv).kind, "error", JSON.stringify(argv));
    assert.equal(parseRelayArgs([], { PORT: "x" }).kind, "error");
  });

  it("値が別のオプションに見える場合は、値の指定漏れとして断る（--origin --ports 80 など）", () => {
    const parsed = parseRelayArgs(["--origin", "--ports", "80"]);
    assert.equal(parsed.kind, "error");
  });
});

describe("buildWispOptions", () => {
  it("既定: 接続先は IPv4 リテラルだけ。ループバック・プライベートは断る。80/443 だけ。UDP なし", () => {
    const options = buildWispOptions(runConfig([]));
    const whitelist = options["hostname_whitelist"] as RegExp[];
    assert.equal(Array.isArray(whitelist), true);
    // wisp-js は entry.test(hostname) を呼ぶので、RegExp でなければならない
    assert.ok(whitelist.every((entry) => entry instanceof RegExp));
    assert.equal(whitelist.some((entry) => entry.test("::ffff:127.0.0.1")), false);
    assert.equal(whitelist.some((entry) => entry.test("1.1.1.1")), true);
    assert.equal(options["hostname_blacklist"], null);
    assert.equal(options["allow_direct_ip"], true);
    assert.equal(options["allow_loopback_ips"], false);
    assert.equal(options["allow_private_ips"], false);
    assert.deepEqual(options["port_whitelist"], [80, 443]);
    assert.equal(options["allow_udp_streams"], false);
    assert.equal(options["allow_tcp_streams"], true);
    assert.equal(options["stream_limit_total"], STREAM_LIMIT_TOTAL);
    assert.equal(options["parse_real_ip"], false);
  });

  it("--unsafe-allow-private でも、IPv6・名前は断ったまま", () => {
    const options = buildWispOptions(runConfig(["--unsafe-allow-private"]));
    assert.equal(options["allow_loopback_ips"], true);
    assert.equal(options["allow_private_ips"], true);
    const whitelist = options["hostname_whitelist"] as RegExp[];
    assert.equal(whitelist.some((entry) => entry.test("::ffff:127.0.0.1")), false);
    assert.equal(whitelist.some((entry) => entry.test("localhost")), false);
  });

  it("--ports all は、ポートの制限なし（null）、--allow-udp は UDP を許す", () => {
    const options = buildWispOptions(runConfig(["--ports", "all", "--allow-udp"]));
    assert.equal(options["port_whitelist"], null);
    assert.equal(options["allow_udp_streams"], true);
  });
});

describe("checkUpgrade", () => {
  const config = { origins: ["https://app.example", "http://localhost:8080"] };

  it("Origin がない接続（ブラウザ以外）と、許可した Origin は通す", () => {
    assert.deepEqual(checkUpgrade({ url: "/", origin: undefined }, config), { ok: true });
    assert.deepEqual(checkUpgrade({ url: "/", origin: "https://app.example" }, config), { ok: true });
    assert.deepEqual(checkUpgrade({ url: "/wisp/", origin: "http://localhost:8080" }, config), { ok: true });
    assert.deepEqual(checkUpgrade({ url: undefined, origin: undefined }, config), { ok: true });
  });

  it("許可していない Origin は 403。near-miss（スキーム・ポート・サブドメイン違い・null）も断る", () => {
    for (const origin of ["https://evil.example", "http://app.example", "https://app.example:8443", "https://sub.app.example", "https://app.example.evil.example", "null", ""]) {
      const result = checkUpgrade({ url: "/", origin }, config);
      assert.equal(result.ok, false, JSON.stringify(origin));
      if (!result.ok) assert.equal(result.status, 403);
    }
  });

  it("URL が / で終わらないもの（wsproxy の形）・クエリ付き・絶対形式は 404", () => {
    for (const url of ["/1.2.3.4:80", "/wisp", "/x/y", "/?a=b/c", "/?a=b", "/#x/", "http://relay.example/", "", "x/"]) {
      const result = checkUpgrade({ url, origin: undefined }, config);
      assert.equal(result.ok, false, JSON.stringify(url));
      if (!result.ok) assert.equal(result.status, 404);
    }
  });
});
