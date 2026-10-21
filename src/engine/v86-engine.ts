import { toNetDevice, validateNetworkConfig } from "./network.ts";
import type { NetworkConfig } from "./network.ts";
import type { Engine, EngineBootOptions } from "./types.ts";
import { V86BlockDevice } from "./v86-block-device.ts";

const MiB = 1024 * 1024;

/**
 * v86 のエミュレータのうち、WasmBox が使う部分だけ。
 * `serial0-output-byte` と `serial0_send` は、v86 の公開 API（add_listener / serial0_send）。
 */
export interface V86Emulator {
  add_listener(event: "serial0-output-byte", listener: (byte: number) => void): void;
  /** 文字列の各文字の下位 8 ビットを、1 バイトずつシリアル入力として送る */
  serial0_send(data: string): void;
  destroy?(): Promise<void> | void;
}

/** libv86.js が公開するグローバルの `V86` */
export type V86Constructor = new (options: Record<string, unknown>) => V86Emulator;

export interface V86EngineAssets {
  /** v86.wasm */
  wasm: string;
  /** seabios.bin */
  bios: string;
  /** vgabios.bin */
  vgaBios: string;
  /** ディスク（IDE）に対応したカーネル（bzImage） */
  kernel: string;
  /** 直接ルート起動用の外付け initrd（`rdinit=/wasmbox-init` と組で使う）。image/README.md */
  initrd?: string;
}

export interface V86EngineOptions {
  /** libv86.js が定義する `V86`。グローバルをそのまま使わず、呼び出し側から渡す（テストで差し替えるため）。 */
  V86: V86Constructor;
  assets: V86EngineAssets;
  /** カーネルのコマンドライン */
  cmdline: string;
  /** ディスク I/O の失敗通知。v86 には失敗を伝える手段がなく、失敗するとゲストの該当 I/O は止まる。 */
  onDiskError?: (error: unknown) => void;
  /** ゲストのネットワーク。指定しなければ NIC を付けない（ネットワークなし）。起動後には変えられない。 */
  network?: NetworkConfig;
}

/**
 * v86 を使う Engine。ディスクは V86BlockDevice を hda として渡す（v86 のパッチは不要）。
 *
 * ゲストのシリアルコンソール（ttyS0）が、ターミナルの入出力になる。
 */
export class V86Engine implements Engine {
  readonly #options: V86EngineOptions;
  #emulator: V86Emulator | undefined;
  #device: V86BlockDevice | undefined;
  #started = false;

  constructor(options: V86EngineOptions) {
    if (options.network) validateNetworkConfig(options.network); // 設定ミスは、起動前に分かるようにする
    this.#options = options;
  }

  async boot(options: EngineBootOptions): Promise<void> {
    if (this.#started) throw new Error("このエンジンはすでに起動しています（boot は 1 回だけ）");
    if (!Number.isFinite(options.memoryMiB) || options.memoryMiB < 64 || options.memoryMiB > 2048) {
      throw new RangeError(`memoryMiB は 64〜2048 で指定してください: ${options.memoryMiB}`);
    }
    this.#started = true;

    const { V86, assets, cmdline, onDiskError, network } = this.#options;
    const device = new V86BlockDevice(options.disk, onDiskError ? { onError: onDiskError } : {});
    this.#device = device;

    const emulator = new V86({
      wasm_path: assets.wasm,
      bios: { url: assets.bios },
      vga_bios: { url: assets.vgaBios },
      bzimage: { url: assets.kernel },
      ...(assets.initrd ? { initrd: { url: assets.initrd } } : {}),
      cmdline,
      hda: device,
      ...(network ? { net_device: toNetDevice(network) } : {}),
      memory_size: options.memoryMiB * MiB,
      // 入出力はシリアルだけ。画面・キーボード・マウス・スピーカーは使わない
      disable_mouse: true,
      disable_keyboard: true,
      disable_speaker: true,
      autostart: true,
    });
    this.#emulator = emulator;

    // v86 は出力を 1 バイトずつ通知する。同じ処理（タスク）の間に届いた分をまとめて渡す。
    let pending: number[] = [];
    let scheduled = false;
    emulator.add_listener("serial0-output-byte", (byte) => {
      pending.push(byte & 0xff);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const chunk = Uint8Array.from(pending);
        pending = [];
        options.onOutput(chunk);
      });
    });
  }

  input(data: Uint8Array): void {
    const emulator = this.#emulator;
    if (!emulator) throw new Error("エンジンが動いていません（boot の前、または dispose の後です）");
    // serial0_send は、文字列の各文字を 1 バイトとして送る。UTF-8 のバイト列を、1 文字 = 1 バイトの文字列にして渡す
    let text = "";
    for (const byte of data) text += String.fromCharCode(byte);
    emulator.serial0_send(text);
  }

  /** 発行済みの書き込みを、すべて IndexedDB へ保存する。installAutoFlush に渡せる。 */
  async flush(): Promise<void> {
    await this.#device?.flush();
  }

  async dispose(): Promise<void> {
    const emulator = this.#emulator;
    const device = this.#device;
    this.#emulator = undefined;
    this.#device = undefined;
    try {
      await device?.flush();
    } finally {
      // 保存に失敗しても、エミュレータは止める。失敗は呼び出し元に伝わる。
      await emulator?.destroy?.();
    }
  }
}
