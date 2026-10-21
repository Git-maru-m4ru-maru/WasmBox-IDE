import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { V86BlockDevice } from "../src/engine/v86-block-device.ts";
import { V86Engine } from "../src/engine/v86-engine.ts";
import type { NetworkConfig } from "../src/engine/network.ts";
import type { V86Emulator } from "../src/engine/v86-engine.ts";
import { eventually, makeImage, newEnv, openStore, sleep } from "./helpers.ts";

// 40960 バイト = 80 セクタ / チャンク 4096 バイト = 10 チャンク
const SIZE = 40960;
const CS = 4096;
const MiB = 1024 * 1024;

const ASSETS = {
  wasm: "vendor/v86.wasm",
  bios: "vendor/seabios.bin",
  vgaBios: "vendor/vgabios.bin",
  kernel: "vendor/kernel.bin",
};

/** v86 の代わりに、渡されたオプションと、シリアルの入出力を記録する */
class FakeV86 implements V86Emulator {
  static last: FakeV86 | undefined;
  readonly options: Record<string, unknown>;
  readonly sent: string[] = [];
  readonly events: string[] = [];
  #serialListener: ((byte: number) => void) | undefined;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeV86.last = this;
  }

  add_listener(_event: "serial0-output-byte", listener: (byte: number) => void): void {
    this.#serialListener = listener;
  }

  serial0_send(data: string): void {
    this.sent.push(data);
  }

  async destroy(): Promise<void> {
    this.events.push("destroy");
  }

  /** ゲストがシリアルに 1 バイトずつ出力したことにする */
  emit(bytes: readonly number[]): void {
    for (const byte of bytes) this.#serialListener?.(byte);
  }
}

async function setup(extra: { initrd?: string } = {}) {
  const image = await makeImage({ size: SIZE, chunkSize: CS });
  const env = newEnv(image);
  const store = await openStore(image, env);
  const outputs: Uint8Array[] = [];
  const engine = new V86Engine({
    V86: FakeV86,
    assets: { ...ASSETS, ...extra },
    cmdline: "console=ttyS0 root=/dev/sda",
  });
  const boot = () => engine.boot({ disk: store, memoryMiB: 256, onOutput: (data) => outputs.push(data) });
  return { image, env, store, engine, outputs, boot };
}

function emulator(): FakeV86 {
  const last = FakeV86.last;
  if (!last) throw new Error("v86 が作られていません");
  return last;
}

describe("V86Engine", () => {
  it("v86 に、アセット・コマンドライン・ディスク・RAM を渡して起動する", async () => {
    const { boot } = await setup();
    await boot();
    const options = emulator().options;
    assert.deepEqual(options["wasm_path"], "vendor/v86.wasm");
    assert.deepEqual(options["bios"], { url: "vendor/seabios.bin" });
    assert.deepEqual(options["vga_bios"], { url: "vendor/vgabios.bin" });
    assert.deepEqual(options["bzimage"], { url: "vendor/kernel.bin" });
    assert.equal(options["cmdline"], "console=ttyS0 root=/dev/sda");
    assert.equal(options["memory_size"], 256 * MiB);
    assert.equal(options["autostart"], true);
    assert.equal("initrd" in options, false);
    assert.ok(options["hda"] instanceof V86BlockDevice);
    assert.equal((options["hda"] as V86BlockDevice).byteLength, SIZE);
  });

  it("initrd を指定したときだけ、v86 に渡す", async () => {
    const { boot } = await setup({ initrd: "image/initrd.cpio" });
    await boot();
    assert.deepEqual(emulator().options["initrd"], { url: "image/initrd.cpio" });
  });

  it("network を指定したときだけ、net_device を v86 に渡す。設定が不正なら、作った時点で例外", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const store = await openStore(image, newEnv(image));
    const make = (network?: NetworkConfig) =>
      new V86Engine({ V86: FakeV86, assets: ASSETS, cmdline: "console=ttyS0", ...(network ? { network } : {}) });

    await make().boot({ disk: store, memoryMiB: 256, onOutput: () => {} });
    assert.equal("net_device" in emulator().options, false, "既定ではネットワークなし");

    await make({ mode: "relay", url: "wisps://relay.example/", nic: "virtio" }).boot({ disk: store, memoryMiB: 256, onOutput: () => {} });
    assert.deepEqual(emulator().options["net_device"], { type: "virtio", relay_url: "wisps://relay.example/" });

    assert.throws(() => make({ mode: "relay", url: "http://relay.example/" }), /ws:\/\/ wss:\/\/ wisp:\/\/ wisps:\/\//);
  });

  it("シリアルの出力を、1 バイトずつではなくまとめて onOutput に渡す", async () => {
    const { boot, outputs } = await setup();
    await boot();
    emulator().emit([0x68, 0x69, 0x0a]); // "hi\n"
    assert.equal(outputs.length, 0, "同じ処理の中では渡さない（まとめるため）");
    await sleep(0);
    assert.equal(outputs.length, 1);
    assert.deepEqual([...(outputs[0] ?? [])], [0x68, 0x69, 0x0a]);

    emulator().emit([0x21]);
    await sleep(0);
    assert.equal(outputs.length, 2);
    assert.deepEqual([...(outputs[1] ?? [])], [0x21]);
  });

  it("入力は UTF-8 のバイトのまま、1 文字 = 1 バイトの文字列としてシリアルに送る", async () => {
    const { boot, engine } = await setup();
    await boot();
    engine.input(new TextEncoder().encode("あ\r"));
    assert.equal(emulator().sent.length, 1);
    const sent = emulator().sent[0] ?? "";
    assert.deepEqual([...sent].map((c) => c.charCodeAt(0)), [0xe3, 0x81, 0x82, 0x0d]);
  });

  it("boot の前や dispose の後の input、2 回目の boot は例外", async () => {
    const { boot, engine } = await setup();
    assert.throws(() => engine.input(Uint8Array.from([0x61])), /boot/);
    await boot();
    await assert.rejects(boot(), /すでに/);
    await engine.dispose();
    assert.throws(() => engine.input(Uint8Array.from([0x61])), /boot/);
  });

  it("RAM の範囲外は RangeError", async () => {
    const { store, engine } = await setup();
    for (const memoryMiB of [0, 63, 2049, Number.NaN]) {
      await assert.rejects(engine.boot({ disk: store, memoryMiB, onOutput: () => {} }), RangeError);
    }
  });

  it("dispose は、書き込み済みのディスクを保存してから v86 を止める（二重に呼んでも安全）", async () => {
    const { boot, engine, env } = await setup();
    await boot();
    const hda = emulator().options["hda"] as V86BlockDevice;
    await new Promise<void>((resolve) => hda.set(0, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), resolve));
    assert.deepEqual(await env.instance.keys("o:"), [], "dispose 前は保存されていない（flush を呼んでいないため）");

    // v86 を止める時点で、保存が済んでいることを確かめる（順序の検査）
    const fake = emulator();
    const originalDestroy = fake.destroy.bind(fake);
    let savedWhenStopped: string[] | undefined;
    fake.destroy = async () => {
      savedWhenStopped = await env.instance.keys("o:");
      await originalDestroy();
    };

    env.instance.batchDelayMs = 20; // 保存に時間がかかっても、止めるのはその後
    await engine.dispose();
    assert.deepEqual(savedWhenStopped, ["o:0"], "v86 を止める前に、保存が終わっていない");
    assert.deepEqual(await env.instance.keys("o:"), ["o:0"]);
    assert.deepEqual(emulator().events, ["destroy"]);
    await engine.dispose();
    assert.deepEqual(emulator().events, ["destroy"]);
  });

  it("保存に失敗しても v86 は止め、失敗は dispose の呼び出し元に伝える", async () => {
    const { boot, engine, env } = await setup();
    await boot();
    const hda = emulator().options["hda"] as V86BlockDevice;
    await new Promise<void>((resolve) => hda.set(0, Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]), resolve));
    env.instance.failBatches = 1;
    await assert.rejects(engine.dispose(), /注入された書き込み失敗/);
    assert.deepEqual(emulator().events, ["destroy"]);
  });

  it("flush は、発行済みの書き込みを IndexedDB 側（KV）まで保存する", async () => {
    const { boot, engine, env } = await setup();
    await boot();
    const hda = emulator().options["hda"] as V86BlockDevice;
    await new Promise<void>((resolve) => hda.set(CS, Uint8Array.from([7, 7, 7, 7, 7, 7, 7, 7]), resolve));
    await engine.flush();
    await eventually(async () => (await env.instance.keys("o:")).includes("o:1"));
  });
});
