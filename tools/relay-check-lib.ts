import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";

/**
 * WISP リレーの接続先フィルタを、外から確かめるための部品（tools/relay-check.mjs が使う）。
 * 任意の WISP サーバー（wisp-js に限らない）に、WISP v1 のクライアントとして接続して、
 * 「内部のアドレスへの接続を、サーバーが断るか」を調べる。リレーの実装（wisp-js）には依存しない。
 *
 * WISP v1 のパケット: [種類 u8][ストリーム ID u32 LE][本体]
 *   CONNECT=0x01（本体: ストリームの種類 u8（TCP=1, UDP=2）, ポート u16 LE, ホスト名）, DATA=0x02, CONTINUE=0x03, CLOSE=0x04（本体: 理由 u8）
 */

export const PACKET = { CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04 } as const;
export const STREAM_TCP = 0x01;
export const STREAM_UDP = 0x02;
/** WISP の CLOSE の理由。0x48 が「接続先がサーバーの方針で禁止されている」 */
export const REASON_HOST_BLOCKED = 0x48;

const REASON_NAMES: Record<number, string> = {
  0x01: "Unknown",
  0x02: "Voluntary",
  0x03: "NetworkError",
  0x04: "IncompatibleExtensions",
  0x41: "InvalidInfo",
  0x42: "UnreachableHost",
  0x43: "NoResponse",
  0x44: "ConnRefused",
  0x47: "TransferTimeout",
  0x48: "HostBlocked",
  0x49: "ConnThrottled",
};
export const reasonName = (reason: number): string => REASON_NAMES[reason] ?? "不明";

export function encodeConnect(streamId: number, type: typeof STREAM_TCP | typeof STREAM_UDP, port: number, host: string): Uint8Array<ArrayBuffer> {
  const name = new TextEncoder().encode(host);
  const out = new Uint8Array(1 + 4 + 1 + 2 + name.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, PACKET.CONNECT);
  view.setUint32(1, streamId, true);
  view.setUint8(5, type);
  view.setUint16(6, port, true);
  out.set(name, 8);
  return out;
}

export type DecodedPacket = { type: number; streamId: number; body: Uint8Array };

export function decodePacket(bytes: Uint8Array): DecodedPacket | undefined {
  if (bytes.length < 5) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: view.getUint8(0), streamId: view.getUint32(1, true), body: bytes.subarray(5) };
}

/** `wisp://` / `wisps://` を、WebSocket の URL にする。`ws://` / `wss://` はそのまま */
export function toWebSocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "wisp:") return "ws:" + relayUrl.slice("wisp:".length);
  if (url.protocol === "wisps:") return "wss:" + relayUrl.slice("wisps:".length);
  if (url.protocol === "ws:" || url.protocol === "wss:") return relayUrl;
  throw new Error(`リレーの URL は wisp:// wisps:// ws:// wss:// のどれかです: ${relayUrl}`);
}

// ---------------------------------------------------------------------------
// 検査する接続先
// ---------------------------------------------------------------------------

/**
 * required    … 内部への迂回。断られなければ失敗（公開してはいけない）
 * recommended … 断るのが望ましい（悪用の抑止）。断られなければ警告
 * info        … 結果を表示するだけ（断られたら、通常の通信にも使えない可能性があるので警告）
 */
export type Level = "required" | "recommended" | "info";

export interface CheckCase {
  id: string;
  label: string;
  host: string;
  port: number;
  type: typeof STREAM_TCP | typeof STREAM_UDP;
  level: Level;
}

const tcp = (id: string, label: string, host: string, port: number, level: Level): CheckCase => ({ id, label, host, port, type: STREAM_TCP, level });

export const CHECK_CASES: readonly CheckCase[] = [
  // 内部への迂回（要件）
  tcp("loopback4", "IPv4 ループバック", "127.0.0.1", 80, "required"),
  tcp("unspecified4", "IPv4 の未指定アドレス", "0.0.0.0", 80, "required"),
  tcp("loopback-name", "名前 localhost", "localhost", 80, "required"),
  tcp("loopback6", "IPv6 ループバック", "::1", 80, "required"),
  tcp("mapped-loopback", "IPv4 マッピング（ループバック）", "::ffff:127.0.0.1", 80, "required"),
  tcp("mapped-loopback-hex", "IPv4 マッピング（16 進。ループバック）", "::ffff:7f00:1", 80, "required"),
  tcp("short-loopback", "短縮表記 127.1", "127.1", 80, "required"),
  tcp("decimal-loopback", "10 進表記 2130706433", "2130706433", 80, "required"),
  tcp("hex-loopback", "16 進表記 0x7f.0.0.1", "0x7f.0.0.1", 80, "required"),
  tcp("private-10", "プライベート 10.0.0.1", "10.0.0.1", 80, "required"),
  tcp("private-172", "プライベート 172.16.0.1", "172.16.0.1", 80, "required"),
  tcp("private-192", "プライベート 192.168.0.1", "192.168.0.1", 80, "required"),
  tcp("metadata", "リンクローカル 169.254.169.254（クラウドのメタデータ）", "169.254.169.254", 80, "required"),
  tcp("cgnat", "CGNAT 100.64.0.1", "100.64.0.1", 80, "required"),
  tcp("mapped-private", "IPv4 マッピング（プライベート）", "::ffff:10.0.0.1", 80, "required"),
  tcp("mapped-private-192", "IPv4 マッピング（192.168.0.1）", "::ffff:192.168.0.1", 80, "required"),
  tcp("mapped-metadata", "IPv4 マッピング（メタデータ）", "::ffff:169.254.169.254", 80, "required"),
  tcp("ula6", "IPv6 の ULA fd00::1", "fd00::1", 80, "required"),
  tcp("linklocal6", "IPv6 のリンクローカル fe80::1", "fe80::1", 80, "required"),
  // 悪用の抑止（望ましい）
  tcp("port-smtp", "公開 IP の 25 番（SMTP）", "1.1.1.1", 25, "recommended"),
  tcp("port-ssh", "公開 IP の 22 番（SSH）", "1.1.1.1", 22, "recommended"),
  tcp("port-8080", "公開 IP の 8080 番", "1.1.1.1", 8080, "recommended"),
  { id: "udp", label: "公開 IP への UDP（53 番）", host: "1.1.1.1", port: 53, type: STREAM_UDP, level: "recommended" },
  // 情報（通常の通信に使えるかの対照）
  tcp("public-ip-443", "公開 IP の 443 番（対照。断られないはず）", "1.1.1.1", 443, "info"),
];

export type Verdict = "blocked" | "passed" | "error";

export interface ProbeOutcome {
  verdict: Verdict;
  detail: string;
  /** 接続先から返ってきたデータ（接続できたときだけ） */
  data?: Uint8Array;
}

export type Judgement = "ok" | "fail" | "warn" | "info";

/** 1 件の結果を、重さに応じて ok / fail / warn / info にする */
export function judgeCase(checkCase: CheckCase, outcome: ProbeOutcome): Judgement {
  if (checkCase.level === "info") return outcome.verdict === "blocked" ? "warn" : "info";
  if (outcome.verdict === "blocked") return "ok";
  return checkCase.level === "required" ? "fail" : "warn";
}

export interface Summary {
  ok: number;
  fail: number;
  warn: number;
  info: number;
  /** 終了コード: required が 1 件でも外れたら 1 */
  exitCode: 0 | 1;
}

export function summarize(judgements: readonly Judgement[]): Summary {
  const count = (kind: Judgement): number => judgements.filter((j) => j === kind).length;
  const fail = count("fail");
  return { ok: count("ok"), fail, warn: count("warn"), info: count("info"), exitCode: fail > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// 通信（WebSocket は、Node 22 のグローバルのもの。Origin を付けられない）
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  /** CONNECT を送ってから、結果を待つ時間（ミリ秒） */
  timeoutMs?: number;
}

/** 1 つの接続先を、新しい WebSocket 接続で試す */
export function probeConnect(wsUrl: string, target: Pick<CheckCase, "host" | "port" | "type">, options: ProbeOptions = {}): Promise<ProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? 6000;
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      resolve({ verdict: "error", detail: `接続を始められません: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    socket.binaryType = "arraybuffer";
    let sent = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: ProbeOutcome): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      try {
        socket.close();
      } catch {
        // すでに閉じている
      }
      resolve(outcome);
    };
    const sendConnect = (): void => {
      if (sent || finished) return;
      sent = true;
      socket.send(encodeConnect(1, target.type, target.port, target.host));
      timer = setTimeout(() => finish({ verdict: "passed", detail: "時間切れ（フィルタは通過して、接続待ち）" }), timeoutMs);
    };

    // WISP v1 のサーバーは、接続の直後に CONTINUE（ストリーム 0）を送る。来なくても、少し待ってから CONNECT を送る
    fallback = setTimeout(sendConnect, 1500);
    socket.addEventListener("message", (event: MessageEvent) => {
      const packet = decodePacket(new Uint8Array(event.data as ArrayBuffer));
      if (!packet) return;
      if (packet.type === PACKET.CONTINUE && packet.streamId === 0) sendConnect();
      else if (packet.type === PACKET.CLOSE && packet.streamId === 1) {
        const reason = packet.body[0] ?? 0;
        finish(reason === REASON_HOST_BLOCKED ? { verdict: "blocked", detail: "HostBlocked（0x48）" } : { verdict: "passed", detail: `フィルタは通過（CLOSE 0x${reason.toString(16)} ${reasonName(reason)}）` });
      } else if (packet.type === PACKET.DATA && packet.streamId === 1) {
        finish({ verdict: "passed", detail: "接続できて、データが返った", data: packet.body.slice() });
      }
    });
    socket.addEventListener("error", () => finish({ verdict: "error", detail: "WebSocket のエラー（接続できない、または拒否された）" }));
    socket.addEventListener("close", () => finish({ verdict: "error", detail: "CLOSE を返さずに、リレーが接続を切った（拒否か障害か判別できない）" }));
  });
}

/** 並列に（同時に concurrency 件まで）、すべての検査を行う */
export async function runChecks(
  wsUrl: string,
  cases: readonly CheckCase[] = CHECK_CASES,
  options: ProbeOptions & { concurrency?: number } = {},
): Promise<{ case: CheckCase; outcome: ProbeOutcome; judgement: Judgement }[]> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const results: { case: CheckCase; outcome: ProbeOutcome; judgement: Judgement }[] = new Array(cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const checkCase = cases[index];
      if (!checkCase) return;
      const outcome = await probeConnect(wsUrl, checkCase, options);
      results[index] = { case: checkCase, outcome, judgement: judgeCase(checkCase, outcome) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Origin の確認（ブラウザのページから使われるのを断るか）
// ---------------------------------------------------------------------------

export interface OriginOutcome {
  /** 101 = 受け付けた（Origin を確認していない）、403 = 断った、undefined = 接続できなかった */
  status: number | undefined;
  detail: string;
}

/** 指定した Origin を付けて、WebSocket のアップグレードだけを要求する（WISP の中身は送らない） */
export function probeOrigin(wsUrl: string, origin: string, timeoutMs = 5000): Promise<OriginOutcome> {
  return new Promise((resolve) => {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const request = (url.protocol === "https:" ? https : http).request(url, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        Origin: origin,
      },
      timeout: timeoutMs,
    });
    let done = false;
    const finish = (outcome: OriginOutcome): void => {
      if (done) return;
      done = true;
      request.destroy();
      resolve(outcome);
    };
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      finish({ status: 101, detail: "受け付けた（101）" });
    });
    request.on("response", (response) => {
      response.resume();
      finish({ status: response.statusCode, detail: `HTTP ${String(response.statusCode)}` });
    });
    request.on("timeout", () => finish({ status: undefined, detail: "時間切れ" }));
    request.on("error", (error) => finish({ status: undefined, detail: `接続できない: ${error.message}` }));
    request.end();
  });
}

/** 他のサイトの Origin を断るのが望ましい（断れば ok、受け付けたら warn、分からなければ info） */
export function judgeOrigin(outcome: OriginOutcome): Judgement {
  if (outcome.status === 101) return "warn";
  if (outcome.status === 403) return "ok";
  return "info";
}
