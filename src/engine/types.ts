import type { BlockStore } from "../storage/types.ts";

export interface EngineBootOptions {
  /** ルートFSとして見せるディスク */
  disk: BlockStore;
  /** ゲストの RAM（MiB） */
  memoryMiB: number;
  /** ゲストのシリアルコンソールへの出力（ターミナルに表示する） */
  onOutput: (data: Uint8Array) => void;
}

/**
 * エミュレータの差し替えポイント（ARCHITECTURE.md 4.7）。
 * 実装は ./v86-engine.ts。container2wasm など別のエンジンに替えるときは、これを実装する。
 */
export interface Engine {
  /** エミュレータを作って起動する。ゲストの起動は、この Promise が解決したあとも続く（出力で分かる）。 */
  boot(options: EngineBootOptions): Promise<void>;
  /** ターミナルでの入力（UTF-8 のバイト列）をゲストに送る */
  input(data: Uint8Array): void;
  /** 書き込み済みのディスクを保存してから、エミュレータを止める */
  dispose(): Promise<void>;
}
