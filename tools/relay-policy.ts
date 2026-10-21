/**
 * 手元（または自分のサーバー）で動かす WISP リレー（tools/relay.mjs）の方針。
 * wisp-js に依存しない純粋な関数だけを置く（単体テストできるように、リレー本体 relay.mjs から分けてある）。
 *
 * 考え方（ARCHITECTURE.md 5.2 の実測にもとづく）:
 *   - wisp-js 0.5.0 の既定のフィルタは、IPv4 マッピングの IPv6 表記（`::ffff:127.0.0.1`）で迂回できる。
 *   - v86 は、名前をブラウザで解決して、IPv4 アドレス（ドット区切り）でリレーに接続を頼む。
 *   → 接続先を「正規形の IPv4 リテラル」だけに絞る。名前・IPv6・`127.1` や 10 進などの別表記は、すべて断る。
 *     この絞り込みのあとなら、wisp-js の IPv4 のフィルタ（ループバック・プライベート・リンクローカルなど）が正しく効く。
 *   - ブラウザの WebSocket は、どのサイトからでも ws://127.0.0.1 に接続できる。Origin を確認して、他のサイトのページから使われないようにする。
 */

export type PortRule = number | [number, number];

export interface RelayConfig {
  host: string;
  port: number;
  /** 接続を許す Origin（`https://example.com` の形）。Origin のない接続（ブラウザ以外）は許す */
  origins: string[];
  /** 接続先のポート。null は制限なし */
  ports: PortRule[] | null;
  allowUdp: boolean;
  /** 検査用。ループバックとプライベート IP への接続を許す。公開するリレーでは使わない */
  unsafeAllowPrivate: boolean;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE";
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 5001;
/** `npm run site:serve` と `npm run poc:serve` の既定（tools/serve.ts の 8080 番） */
export const DEFAULT_ORIGINS: readonly string[] = ["http://localhost:8080", "http://127.0.0.1:8080"];
export const DEFAULT_PORT_RULES: readonly PortRule[] = [80, 443];
/** 検証した wisp-js の版（リレーはこの版でだけ確かめている） */
export const TESTED_WISP_VERSION = "0.5.0";
/** 1 つの WebSocket 接続で同時に開けるストリームの上限 */
export const STREAM_LIMIT_TOTAL = 256;

/** 0〜255 の正規形（先頭に 0 を付けない）4 つを、ドットでつないだもの。`127.1`・`0177.0.0.1`・`::ffff:1.2.3.4`・名前は一致しない */
export const IPV4_LITERAL: RegExp = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

const isPortNumber = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/** `80,443,8000-8100`（または `all`）を、wisp-js の `port_whitelist` の形にする。`all` は null（制限なし） */
export function parsePortRules(text: string): ParseResult<PortRule[] | null> {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "all") return { ok: true, value: null };
  if (trimmed === "") return { ok: false, message: "ポートの指定が空です（例: 80,443）" };
  const rules: PortRule[] = [];
  for (const part of trimmed.split(",")) {
    const item = part.trim();
    const single = /^\d+$/.exec(item);
    const range = /^(\d+)-(\d+)$/.exec(item);
    if (single) {
      const n = Number(item);
      if (!isPortNumber(n)) return { ok: false, message: `ポート番号が 1〜65535 の範囲にありません: ${item}` };
      rules.push(n);
    } else if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!isPortNumber(lo) || !isPortNumber(hi)) return { ok: false, message: `ポート番号が 1〜65535 の範囲にありません: ${item}` };
      if (lo > hi) return { ok: false, message: `範囲の始まりが終わりより大きいです: ${item}` };
      rules.push([lo, hi]);
    } else {
      return { ok: false, message: `ポートの書き方が分かりません: "${item}"（例: 80,443,8000-8100 または all）` };
    }
  }
  return { ok: true, value: rules };
}

/** Origin として使える URL（http / https、パスなし、ワイルドカードなし）を、正規の形（`new URL(x).origin`）にする */
export function normalizeOrigin(text: string): ParseResult<string> {
  const trimmed = text.trim();
  if (trimmed.includes("*")) return { ok: false, message: `Origin にワイルドカードは使えません: ${trimmed}` };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: `Origin が URL ではありません: ${trimmed}（例: https://example.com）` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: `Origin は http か https のものだけです: ${trimmed}` };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return { ok: false, message: `Origin にパス・クエリ・認証情報は付けません: ${trimmed}（https://example.com のように、サイトの頭の部分だけ）` };
  }
  return { ok: true, value: url.origin };
}

export const isLoopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";

export type ParsedArgs =
  | { kind: "run"; config: RelayConfig }
  | { kind: "help" }
  | { kind: "error"; message: string };

const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "NONE"] as const;

/** 引数（`process.argv.slice(2)`）と環境変数（PORT のみ）から設定を作る */
export function parseRelayArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): ParsedArgs {
  let host = DEFAULT_HOST;
  let portText = env["PORT"] ?? String(DEFAULT_PORT);
  const originTexts: string[] = [];
  let portsText: string | undefined;
  let allowUdp = false;
  let unsafeAllowPrivate = false;
  let logLevel: RelayConfig["logLevel"] = "INFO";

  const valueOf = (index: number, name: string): ParseResult<string> => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${name} には値が要ります` };
    return { ok: true, value };
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    // `--name=value` の形も受け付ける
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const take = (): ParseResult<string> => {
      if (inline !== undefined) return inline === "" ? { ok: false, message: `${name} には値が要ります` } : { ok: true, value: inline };
      const got = valueOf(i, name);
      if (got.ok) i += 1;
      return got;
    };
    switch (name) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--host": {
        const got = take();
        if (!got.ok) return { kind: "error", message: got.message };
        host = got.value;
        break;
      }
      case "--port": {
        const got = take();
        if (!got.ok) return { kind: "error", message: got.message };
        portText = got.value;
        break;
      }
      case "--origin": {
        const got = take();
        if (!got.ok) return { kind: "error", message: got.message };
        originTexts.push(...got.value.split(",").filter((s) => s.trim() !== ""));
        break;
      }
      case "--ports": {
        const got = take();
        if (!got.ok) return { kind: "error", message: got.message };
        portsText = got.value;
        break;
      }
      case "--log": {
        const got = take();
        if (!got.ok) return { kind: "error", message: got.message };
        const upper = got.value.toUpperCase();
        const level = LOG_LEVELS.find((l) => l === upper);
        if (!level) return { kind: "error", message: `--log は ${LOG_LEVELS.join(" / ")} のどれかです: ${got.value}` };
        logLevel = level;
        break;
      }
      case "--allow-udp":
        allowUdp = true;
        break;
      case "--unsafe-allow-private":
        unsafeAllowPrivate = true;
        break;
      default:
        return { kind: "error", message: `分からない引数です: ${arg}（--help で一覧）` };
    }
  }

  if (!/^\d+$/.test(portText) || !isPortNumber(Number(portText))) {
    return { kind: "error", message: `待ち受けのポートが 1〜65535 の整数ではありません: ${portText}` };
  }

  const origins: string[] = [];
  for (const text of originTexts.length > 0 ? originTexts : DEFAULT_ORIGINS) {
    const origin = normalizeOrigin(text);
    if (!origin.ok) return { kind: "error", message: origin.message };
    if (!origins.includes(origin.value)) origins.push(origin.value);
  }

  let ports: PortRule[] | null = [...DEFAULT_PORT_RULES];
  if (portsText !== undefined) {
    const parsed = parsePortRules(portsText);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    ports = parsed.value;
  }

  return { kind: "run", config: { host, port: Number(portText), origins, ports, allowUdp, unsafeAllowPrivate, logLevel } };
}

/** wisp-js の `options` に流し込む値。IPv6・名前・別表記の IPv4 は、`hostname_whitelist` で断る */
export function buildWispOptions(config: RelayConfig): Record<string, unknown> {
  return {
    // 接続先は、正規形の IPv4 リテラルだけ（IPv4 マッピングの IPv6 表記による迂回を塞ぐ。wisp-js の `entry.test()` が呼べるように RegExp で渡す）
    hostname_whitelist: [IPV4_LITERAL],
    hostname_blacklist: null,
    // v86 は IP で接続してくるので、IP リテラルは許す
    allow_direct_ip: true,
    // 既定のまま、ループバック・プライベート・リンクローカル・CGNAT などを断る。検査用の指定のときだけ許す
    allow_loopback_ips: config.unsafeAllowPrivate,
    allow_private_ips: config.unsafeAllowPrivate,
    port_whitelist: config.ports,
    port_blacklist: null,
    stream_limit_total: STREAM_LIMIT_TOTAL,
    allow_tcp_streams: true,
    allow_udp_streams: config.allowUdp,
    // X-Forwarded-For は信用しない（リバースプロキシの内側でも、ログの IP が偽れないように）
    parse_real_ip: false,
  };
}

export type UpgradeCheck = { ok: true } | { ok: false; status: 403 | 404; reason: string };

/**
 * WebSocket のアップグレード要求を通してよいか。
 * - URL は `/` で終わるものだけ（wisp-js は、それ以外を wsproxy として扱う。使わないので断る）。
 * - Origin がある（= ブラウザからの）ときは、許可した Origin だけ。
 */
export function checkUpgrade(request: { url: string | undefined; origin: string | undefined }, config: Pick<RelayConfig, "origins">): UpgradeCheck {
  // wisp-js は、リクエストの URL の文字列（クエリを含む）が `/` で終わるかどうかで、WISP か wsproxy かを決める。
  // 解釈のずれが出ないように、こちらも同じ文字列を見る。クエリ（?）は使わない。
  const url = request.url ?? "/";
  if (!url.startsWith("/") || url.includes("?") || url.includes("#") || !url.endsWith("/")) {
    return { ok: false, status: 404, reason: "WISP のパスは / で始まり、/ で終わります（クエリは付けません）" };
  }
  if (request.origin !== undefined && !config.origins.includes(request.origin)) {
    return { ok: false, status: 403, reason: `Origin が許可されていません: ${request.origin}` };
  }
  return { ok: true };
}

export function helpText(): string {
  return `WasmBox 用の WISP リレー（手元・自分のサーバー用）

使い方:
  npm run relay -- [オプション]

  事前に、wisp-js を入れる（package.json は変わりません）:
    npm install --no-save --package-lock=false @mercuryworkshop/wisp-js@${TESTED_WISP_VERSION}

オプション:
  --host <host>      待ち受けるアドレス（既定 ${DEFAULT_HOST}）。127.0.0.1 以外にすると、他のマシンから使われうる
  --port <port>      待ち受けるポート（既定 ${DEFAULT_PORT}。環境変数 PORT でも指定できる）
  --origin <url>     接続を許すページの Origin（例 https://example.com）。何度でも指定でき、カンマ区切りでもよい
                     既定は ${DEFAULT_ORIGINS.join(" と ")}（npm run site:serve のアドレス）
  --ports <list>     ゲストが接続できる先のポート（既定 ${DEFAULT_PORT_RULES.join(",")}。例 80,443,8000-8100。all で制限なし）
  --allow-udp        UDP を許す（既定は断る）
  --log <level>      DEBUG / INFO / WARN / ERROR / NONE（既定 INFO。INFO にはクライアントの IP と接続先が出る）
  --unsafe-allow-private
                     検査用。ループバックとプライベート IP への接続を許す。公開するリレーでは使わない
  -h, --help         この説明

WasmBox の設定欄（ネットワーク → リレー）には、表示された wisp://… の URL を入れます。

守っていること: 接続先は IPv4 アドレス（ドット区切り）だけ。ループバック・プライベート・リンクローカルなどへは届けない。
他のサイトのページ（Origin が違うもの）からの利用を断る。詳しくは docs/relay.md。
`;
}
