import { isInsecureRelayUrl, validateNetworkConfig } from "../src/engine/index.ts";
import type { NetworkConfig, NicType } from "../src/engine/index.ts";

/** 利用者が選ぶネットワークの設定。ブラウザの localStorage に残す（利用者ごとの設定なので、ディスクには入れない）。 */
export type NetworkMode = "off" | "fetch" | "relay";

export interface NetworkSetting {
  mode: NetworkMode;
  /** mode が relay のときのリレーの URL（wss:// か wisps:// を勧める） */
  relayUrl: string;
  nic: NicType;
}

export const DEFAULT_NETWORK_SETTING: NetworkSetting = { mode: "off", relayUrl: "", nic: "ne2k" };
export const NETWORK_STORAGE_KEY = "wasmbox:network";

const MODES = new Set<string>(["off", "fetch", "relay"]);
const NICS = new Set<string>(["ne2k", "virtio"]);

/** 保存された文字列から設定を復元する。壊れていたり、知らない値が入っていたりしたら、既定（オフ）に戻す。 */
export function parseNetworkSetting(raw: string | null | undefined): NetworkSetting {
  if (!raw) return { ...DEFAULT_NETWORK_SETTING };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { ...DEFAULT_NETWORK_SETTING };
    const record = value as Record<string, unknown>;
    const mode = typeof record["mode"] === "string" && MODES.has(record["mode"]) ? (record["mode"] as NetworkMode) : "off";
    const relayUrl = typeof record["relayUrl"] === "string" ? record["relayUrl"].trim() : "";
    const nic = typeof record["nic"] === "string" && NICS.has(record["nic"]) ? (record["nic"] as NicType) : "ne2k";
    return { mode, relayUrl, nic };
  } catch {
    return { ...DEFAULT_NETWORK_SETTING };
  }
}

export function serializeNetworkSetting(setting: NetworkSetting): string {
  return JSON.stringify({ mode: setting.mode, relayUrl: setting.relayUrl.trim(), nic: setting.nic });
}

/** 自動テスト用: URL パラメータ（net / relay / nic）から設定を作る。net がなければ undefined。 */
export function settingFromParams(params: URLSearchParams): NetworkSetting | undefined {
  const net = params.get("net");
  if (net === null) return undefined;
  const nic = params.get("nic");
  return parseNetworkSetting(
    JSON.stringify({ mode: net, relayUrl: params.get("relay") ?? "", nic: nic ?? "ne2k" }),
  );
}

/** Engine に渡す設定に変換する。オフなら undefined（NIC を付けない）。 */
export function toNetworkConfig(setting: NetworkSetting): NetworkConfig | undefined {
  if (setting.mode === "off") return undefined;
  if (setting.mode === "fetch") return { mode: "fetch", nic: setting.nic };
  return { mode: "relay", url: setting.relayUrl.trim(), nic: setting.nic };
}

/**
 * 設定を使えるか確かめる。使えないなら、利用者に見せる理由（日本語）を返す。使えるなら undefined。
 * pageProtocol は location.protocol（"https:" など）。https のページは、暗号化されない ws:// と wisp:// に接続できない。
 */
export function checkNetworkSetting(setting: NetworkSetting, pageProtocol: string): string | undefined {
  if (setting.mode !== "relay") return undefined;
  const url = setting.relayUrl.trim();
  if (url === "") return "リレーの URL を入力してください（例: wss://relay.example.com/）";
  try {
    validateNetworkConfig({ mode: "relay", url, nic: setting.nic });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (pageProtocol === "https:" && isInsecureRelayUrl(url)) {
    return "https のページからは、暗号化されない ws:// や wisp:// には接続できません。wss:// か wisps:// の URL を使ってください";
  }
  return undefined;
}

/** 画面に出す短い説明 */
export function describeNetworkSetting(setting: NetworkSetting): string {
  if (setting.mode === "off") return "オフ";
  if (setting.mode === "fetch") return "ブラウザのみ（fetch。HTTP だけ）";
  try {
    return "リレー経由（" + new URL(setting.relayUrl.trim()).host + "）";
  } catch {
    return "リレー経由";
  }
}
