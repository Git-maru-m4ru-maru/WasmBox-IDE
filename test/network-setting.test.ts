import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_NETWORK_SETTING,
  checkNetworkSetting,
  describeNetworkSetting,
  parseNetworkSetting,
  serializeNetworkSetting,
  settingFromParams,
  toNetworkConfig,
  withNetworkFlag,
} from "../app/network-setting.ts";
import type { NetworkSetting } from "../app/network-setting.ts";

const relay = (relayUrl: string, nic: "ne2k" | "virtio" = "ne2k"): NetworkSetting => ({ mode: "relay", relayUrl, nic });

describe("parseNetworkSetting / serializeNetworkSetting", () => {
  it("保存したものを、そのまま復元できる", () => {
    for (const setting of [
      DEFAULT_NETWORK_SETTING,
      { mode: "fetch", relayUrl: "", nic: "virtio" },
      relay("wss://relay.example/"),
    ] as NetworkSetting[]) {
      assert.deepEqual(parseNetworkSetting(serializeNetworkSetting(setting)), setting);
    }
  });

  it("保存がない・壊れている・知らない値のときは、安全側（オフ・ne2k）に戻す", () => {
    for (const raw of [null, undefined, "", "not json", "null", "42", "[]", '"relay"']) {
      assert.deepEqual(parseNetworkSetting(raw), DEFAULT_NETWORK_SETTING);
    }
    assert.equal(parseNetworkSetting('{"mode":"tcp"}').mode, "off");
    assert.equal(parseNetworkSetting('{"mode":"relay","nic":"e1000"}').nic, "ne2k");
    assert.equal(parseNetworkSetting('{"mode":"relay","relayUrl":42}').relayUrl, "");
  });

  it("URL の前後の空白は取り除く", () => {
    assert.equal(parseNetworkSetting('{"mode":"relay","relayUrl":"  wss://r.example/ \\n"}').relayUrl, "wss://r.example/");
  });
});

describe("settingFromParams（自動テスト用の URL パラメータ）", () => {
  it("net がなければ undefined（保存された設定を使う）", () => {
    assert.equal(settingFromParams(new URLSearchParams("smoke=1")), undefined);
  });

  it("net / relay / nic から設定を作る。不正な値は安全側に倒す", () => {
    assert.deepEqual(settingFromParams(new URLSearchParams("net=fetch&nic=virtio")), { mode: "fetch", relayUrl: "", nic: "virtio" });
    assert.deepEqual(settingFromParams(new URLSearchParams("net=relay&relay=wisp://127.0.0.1:5001/")), relay("wisp://127.0.0.1:5001/"));
    assert.equal(settingFromParams(new URLSearchParams("net=bogus"))?.mode, "off");
  });
});

describe("toNetworkConfig", () => {
  it("オフなら undefined、fetch / relay は Engine の設定に変換する", () => {
    assert.equal(toNetworkConfig(DEFAULT_NETWORK_SETTING), undefined);
    assert.deepEqual(toNetworkConfig({ mode: "fetch", relayUrl: "ignored", nic: "ne2k" }), { mode: "fetch", nic: "ne2k" });
    assert.deepEqual(toNetworkConfig(relay(" wss://r.example/ ", "virtio")), { mode: "relay", url: "wss://r.example/", nic: "virtio" });
  });
});

describe("withNetworkFlag", () => {
  it("有効なときだけ、コマンドラインの末尾に wasmbox.net=on を足す", () => {
    assert.equal(withNetworkFlag("rw console=ttyS0", true), "rw console=ttyS0 wasmbox.net=on");
    assert.equal(withNetworkFlag("rw console=ttyS0", false), "rw console=ttyS0");
  });
});

describe("checkNetworkSetting", () => {
  it("オフと fetch は常に使える", () => {
    assert.equal(checkNetworkSetting(DEFAULT_NETWORK_SETTING, "https:"), undefined);
    assert.equal(checkNetworkSetting({ mode: "fetch", relayUrl: "", nic: "ne2k" }, "https:"), undefined);
  });

  it("リレーの URL が空・不正なら、理由を返す", () => {
    assert.match(checkNetworkSetting(relay(""), "http:") ?? "", /URL を入力/);
    assert.match(checkNetworkSetting(relay("   "), "http:") ?? "", /URL を入力/);
    assert.match(checkNetworkSetting(relay("http://r.example/"), "http:") ?? "", /ws:\/\/ wss:\/\/ wisp:\/\/ wisps:\/\//);
    assert.match(checkNetworkSetting(relay("not a url"), "http:") ?? "", /URL として読めません/);
  });

  it("https のページでは、暗号化されない ws:// と wisp:// を断る。http のページ（開発用）では許す", () => {
    for (const url of ["ws://127.0.0.1:5001/", "wisp://127.0.0.1:5001/"]) {
      assert.match(checkNetworkSetting(relay(url), "https:") ?? "", /wss:\/\/ か wisps:\/\//);
      assert.equal(checkNetworkSetting(relay(url), "http:"), undefined);
    }
    assert.equal(checkNetworkSetting(relay("wss://r.example/"), "https:"), undefined);
    assert.equal(checkNetworkSetting(relay("wisps://r.example/"), "https:"), undefined);
  });
});

describe("describeNetworkSetting", () => {
  it("利用者に見せる短い説明（リレーはホスト名だけ。パスや認証情報は出さない）", () => {
    assert.equal(describeNetworkSetting(DEFAULT_NETWORK_SETTING), "オフ");
    assert.match(describeNetworkSetting({ mode: "fetch", relayUrl: "", nic: "ne2k" }), /HTTP だけ/);
    const text = describeNetworkSetting(relay("wss://user:secret@relay.example:8443/path?token=abc"));
    assert.match(text, /relay\.example:8443/);
    assert.doesNotMatch(text, /secret|token|path/);
  });
});
