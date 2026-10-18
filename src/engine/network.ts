/**
 * ゲストのネットワーク設定（v86 の `net_device`）。
 *
 * v86 0.5 のネットワーク方式（実物の libv86.js で確認、2026-10-18）:
 * - `relay_url: "fetch"` … ブラウザの fetch でゲストの HTTP（TCP 80 番）だけを中継する。サーバー不要。
 *   HTTPS と、HTTP 以外の通信は通らない。通信先が CORS を許可していないと、ブラウザが応答を渡さない。
 * - `relay_url: "wisp://…"` / `"wisps://…"` … WISP サーバー経由。TCP 全般が通る（HTTPS はゲストの中で TLS を話す）。
 * - `relay_url: "ws://…"` / `"wss://…"` … 従来の WebSocket リレー（Ethernet フレームを中継する）。
 * - `type` は NIC の種類。v86 の既定は "ne2k"。
 */

export type NicType = "ne2k" | "virtio";

export type NetworkConfig =
  | {
      mode: "fetch";
      nic?: NicType;
      /** CORS を許可しない相手へ届けるための、CORS プロキシの URL（http / https） */
      corsProxy?: string;
    }
  | {
      mode: "relay";
      /** ws:// wss:// wisp:// wisps:// のいずれか */
      url: string;
      nic?: NicType;
    };

const RELAY_PROTOCOLS = new Set(["ws:", "wss:", "wisp:", "wisps:"]);
const NIC_TYPES = new Set<string>(["ne2k", "virtio"]);

/** 通信が暗号化されない（ws:// と wisp://）。https のページからは、ブラウザが接続を拒否する。 */
export function isInsecureRelayUrl(url: string): boolean {
  const protocol = parseUrl(url, "リレーの URL")?.protocol;
  return protocol === "ws:" || protocol === "wisp:";
}

function parseUrl(text: string, label: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    throw new TypeError(`${label}を URL として読めません: ${JSON.stringify(text)}`);
  }
}

/** 設定が正しいか検査する。正しくなければ、日本語の理由つきで例外（呼び出し側の入力ミスを、起動前に見つける）。 */
export function validateNetworkConfig(config: NetworkConfig): void {
  if (config.nic !== undefined && !NIC_TYPES.has(config.nic)) {
    throw new RangeError(`NIC の種類は ne2k か virtio です: ${JSON.stringify(config.nic)}`);
  }
  if (config.mode === "relay") {
    const url = parseUrl(config.url, "リレーの URL");
    if (!url || !RELAY_PROTOCOLS.has(url.protocol)) {
      throw new RangeError(
        `リレーの URL は ws:// wss:// wisp:// wisps:// のどれかで始めてください: ${JSON.stringify(config.url)}`,
      );
    }
    if (url.hostname === "") {
      throw new RangeError(`リレーの URL にホスト名がありません: ${JSON.stringify(config.url)}`);
    }
    return;
  }
  if (config.mode === "fetch") {
    if (config.corsProxy !== undefined) {
      const proxy = parseUrl(config.corsProxy, "CORS プロキシの URL");
      if (!proxy || (proxy.protocol !== "http:" && proxy.protocol !== "https:")) {
        throw new RangeError(`CORS プロキシの URL は http:// か https:// で始めてください: ${JSON.stringify(config.corsProxy)}`);
      }
    }
    return;
  }
  throw new RangeError(`ネットワークの方式が不明です: ${JSON.stringify((config as { mode?: unknown }).mode)}`);
}

/** v86 の `net_device` オプションに変換する（検査も行う）。 */
export function toNetDevice(config: NetworkConfig): Record<string, unknown> {
  validateNetworkConfig(config);
  const type = config.nic ?? "ne2k";
  if (config.mode === "relay") return { type, relay_url: config.url };
  return { type, relay_url: "fetch", ...(config.corsProxy !== undefined ? { cors_proxy: config.corsProxy } : {}) };
}
