import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECK_CASES,
  decodePacket,
  encodeConnect,
  judgeCase,
  judgeOrigin,
  PACKET,
  reasonName,
  REASON_HOST_BLOCKED,
  STREAM_TCP,
  STREAM_UDP,
  summarize,
  toWebSocketUrl,
} from "../tools/relay-check-lib.ts";
import type { CheckCase, ProbeOutcome } from "../tools/relay-check-lib.ts";

const outcome = (verdict: ProbeOutcome["verdict"]): ProbeOutcome => ({ verdict, detail: "" });
const caseOf = (level: CheckCase["level"]): CheckCase => ({ id: "x", label: "x", host: "127.0.0.1", port: 80, type: STREAM_TCP, level });

describe("WISP v1 のパケット", () => {
  it("CONNECT は、[種類][ストリーム ID(LE)][TCP/UDP][ポート(LE)][ホスト名]", () => {
    const bytes = encodeConnect(1, STREAM_TCP, 443, "::ffff:127.0.0.1");
    assert.deepEqual([...bytes.subarray(0, 8)], [0x01, 1, 0, 0, 0, 0x01, 0xbb, 0x01]);
    assert.equal(new TextDecoder().decode(bytes.subarray(8)), "::ffff:127.0.0.1");
    assert.equal(encodeConnect(0x01020304, STREAM_UDP, 53, "a")[5], 0x02);
    assert.deepEqual([...encodeConnect(0x01020304, STREAM_UDP, 53, "a").subarray(1, 5)], [4, 3, 2, 1]);
  });

  it("decodePacket は、種類・ストリーム ID・本体に分ける。5 バイト未満は undefined", () => {
    const packet = decodePacket(new Uint8Array([0x04, 1, 0, 0, 0, 0x48]));
    assert.equal(packet?.type, PACKET.CLOSE);
    assert.equal(packet?.streamId, 1);
    assert.deepEqual([...(packet?.body ?? [])], [REASON_HOST_BLOCKED]);
    assert.equal(decodePacket(new Uint8Array([0x03, 0, 0, 0])), undefined);
    // 別のバッファの一部（byteOffset が 0 でない）でも読める
    const whole = new Uint8Array([9, 9, 0x03, 0, 0, 0, 0, 0x10, 0, 0, 0]);
    const part = decodePacket(whole.subarray(2));
    assert.equal(part?.type, PACKET.CONTINUE);
    assert.equal(part?.streamId, 0);
    assert.equal(part?.body.length, 4);
  });

  it("理由の名前", () => {
    assert.equal(reasonName(0x48), "HostBlocked");
    assert.equal(reasonName(0x44), "ConnRefused");
    assert.equal(reasonName(0xff), "不明");
  });
});

describe("toWebSocketUrl", () => {
  it("wisp:// → ws://、wisps:// → wss://。ws / wss はそのまま", () => {
    assert.equal(toWebSocketUrl("wisp://127.0.0.1:5001/"), "ws://127.0.0.1:5001/");
    assert.equal(toWebSocketUrl("wisps://relay.example/wisp/"), "wss://relay.example/wisp/");
    assert.equal(toWebSocketUrl("ws://localhost:1/"), "ws://localhost:1/");
    assert.equal(toWebSocketUrl("wss://localhost/"), "wss://localhost/");
  });

  it("それ以外は例外", () => {
    assert.throws(() => toWebSocketUrl("http://127.0.0.1/"), /wisp:\/\//);
    assert.throws(() => toWebSocketUrl("not a url"));
    assert.throws(() => toWebSocketUrl(""));
  });
});

describe("judgeCase", () => {
  it("必須: 断られれば ok。通過しても、判別できなくても fail", () => {
    assert.equal(judgeCase(caseOf("required"), outcome("blocked")), "ok");
    assert.equal(judgeCase(caseOf("required"), outcome("passed")), "fail");
    assert.equal(judgeCase(caseOf("required"), outcome("error")), "fail");
  });

  it("推奨: 断られれば ok。それ以外は warn（失敗にはしない）", () => {
    assert.equal(judgeCase(caseOf("recommended"), outcome("blocked")), "ok");
    assert.equal(judgeCase(caseOf("recommended"), outcome("passed")), "warn");
    assert.equal(judgeCase(caseOf("recommended"), outcome("error")), "warn");
  });

  it("参考: 通過は info。断られたら warn（通常の通信にも使えない可能性）", () => {
    assert.equal(judgeCase(caseOf("info"), outcome("passed")), "info");
    assert.equal(judgeCase(caseOf("info"), outcome("error")), "info");
    assert.equal(judgeCase(caseOf("info"), outcome("blocked")), "warn");
  });
});

describe("judgeOrigin", () => {
  it("403 は ok、101（受け付けた）は warn、接続できなければ info", () => {
    assert.equal(judgeOrigin({ status: 403, detail: "" }), "ok");
    assert.equal(judgeOrigin({ status: 101, detail: "" }), "warn");
    assert.equal(judgeOrigin({ status: undefined, detail: "" }), "info");
    assert.equal(judgeOrigin({ status: 404, detail: "" }), "info");
  });
});

describe("summarize", () => {
  it("fail が 1 件でもあれば終了コード 1。warn・info だけなら 0", () => {
    assert.deepEqual(summarize(["ok", "ok", "warn", "info"]), { ok: 2, fail: 0, warn: 1, info: 1, exitCode: 0 });
    assert.equal(summarize(["ok", "fail"]).exitCode, 1);
    assert.equal(summarize([]).exitCode, 0);
  });
});

describe("CHECK_CASES", () => {
  it("id が重複しない", () => {
    const ids = CHECK_CASES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("wisp-js 0.5.0 の既定で実測した迂回（IPv4 マッピング・ULA）は、必須として入っている", () => {
    const required = new Set(CHECK_CASES.filter((c) => c.level === "required").map((c) => c.host));
    for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "fd00::1", "127.0.0.1", "169.254.169.254", "10.0.0.1", "192.168.0.1", "localhost"]) {
      assert.ok(required.has(host), host);
    }
  });

  it("必須の項目は、すべてポート 80（ポートの制限で断られて、成功に見えることがないように、制限の対象外の 80 を使う）", () => {
    for (const c of CHECK_CASES.filter((x) => x.level === "required")) assert.equal(c.port, 80, c.id);
  });

  it("推奨の項目に、ポートの制限（25・22・8080）と UDP がある。対照として公開 IP の 443 がある", () => {
    const recommended = CHECK_CASES.filter((c) => c.level === "recommended");
    assert.deepEqual(
      recommended.filter((c) => c.type === STREAM_TCP).map((c) => c.port).sort((a, b) => a - b),
      [22, 25, 8080],
    );
    assert.ok(recommended.some((c) => c.type === STREAM_UDP));
    assert.ok(CHECK_CASES.some((c) => c.level === "info" && c.port === 443));
  });
});
