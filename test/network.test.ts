import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInsecureRelayUrl, toNetDevice, validateNetworkConfig } from "../src/engine/network.ts";
import type { NetworkConfig } from "../src/engine/network.ts";

describe("toNetDevice", () => {
  it("fetch 方式: relay_url は \"fetch\"、NIC は既定で ne2k", () => {
    assert.deepEqual(toNetDevice({ mode: "fetch" }), { type: "ne2k", relay_url: "fetch" });
  });

  it("fetch 方式: NIC と CORS プロキシを指定できる", () => {
    assert.deepEqual(toNetDevice({ mode: "fetch", nic: "virtio", corsProxy: "https://proxy.example/" }), {
      type: "virtio",
      relay_url: "fetch",
      cors_proxy: "https://proxy.example/",
    });
  });

  it("リレー方式: URL をそのまま relay_url に渡す", () => {
    for (const url of ["wss://relay.example/", "wisps://relay.example/wisp/", "ws://127.0.0.1:8080", "wisp://localhost:4000/"]) {
      assert.deepEqual(toNetDevice({ mode: "relay", url }), { type: "ne2k", relay_url: url });
    }
    assert.equal(toNetDevice({ mode: "relay", url: "wss://r.example/", nic: "virtio" })["type"], "virtio");
  });
});

describe("validateNetworkConfig", () => {
  const bad = (config: unknown, pattern: RegExp) =>
    assert.throws(() => validateNetworkConfig(config as NetworkConfig), pattern);

  it("リレーの URL は ws / wss / wisp / wisps だけ。http や読めない文字列は拒否する", () => {
    bad({ mode: "relay", url: "http://relay.example/" }, /ws:\/\/ wss:\/\/ wisp:\/\/ wisps:\/\//);
    bad({ mode: "relay", url: "https://relay.example/" }, /ws:\/\//);
    bad({ mode: "relay", url: "relay.example" }, /URL として読めません/);
    bad({ mode: "relay", url: "" }, /URL として読めません/);
    bad({ mode: "relay", url: "javascript:alert(1)" }, /ws:\/\//);
  });

  it("リレーの URL にホスト名がなければ拒否する", () => {
    // wisp: は URL の仕様上「特殊なスキーム」ではないので、空のホストが許される。ここで弾く
    bad({ mode: "relay", url: "wisp:///path" }, /ホスト名がありません/);
    bad({ mode: "relay", url: "wisps://" }, /ホスト名がありません/);
    // wss: など特殊なスキームは、読む段階で拒否される
    bad({ mode: "relay", url: "wss://" }, /URL として読めません/);
  });

  it("CORS プロキシは http / https だけ", () => {
    bad({ mode: "fetch", corsProxy: "ftp://proxy.example/" }, /http:\/\/ か https:\/\//);
    bad({ mode: "fetch", corsProxy: "not a url" }, /URL として読めません/);
    validateNetworkConfig({ mode: "fetch", corsProxy: "http://localhost:8081/" });
  });

  it("NIC の種類と方式が不正なら拒否する（型を通り抜けた入力への備え）", () => {
    bad({ mode: "fetch", nic: "e1000" }, /ne2k か virtio/);
    bad({ mode: "relay", url: "wss://r.example/", nic: "" }, /ne2k か virtio/);
    bad({ mode: "tcp" }, /方式が不明/);
    bad({}, /方式が不明/);
  });
});

describe("isInsecureRelayUrl", () => {
  it("暗号化されない ws:// と wisp:// だけ true（https のページからは接続できない）", () => {
    assert.equal(isInsecureRelayUrl("ws://relay.example/"), true);
    assert.equal(isInsecureRelayUrl("wisp://relay.example/"), true);
    assert.equal(isInsecureRelayUrl("wss://relay.example/"), false);
    assert.equal(isInsecureRelayUrl("wisps://relay.example/"), false);
  });
});
