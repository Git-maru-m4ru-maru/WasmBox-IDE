import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChunkedBlockStore } from "../src/storage/block-store.ts";
import { MemoryKV } from "../src/storage/kv-memory.ts";
import type { KVOp } from "../src/storage/types.ts";
import {
  CountingSource,
  TestKV,
  eventually,
  makeImage,
  newEnv,
  openStore,
  pseudoRandomBytes,
  sleep,
} from "./helpers.ts";
import type { Env, TestImage } from "./helpers.ts";

// 1000 バイト / チャンク 128 バイト = 8 チャンク（最後は 104 バイト）
const SIZE = 1000;
const CS = 128;

function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new RangeError(`添字が範囲外です: ${index}`);
  return value;
}

describe("アイドル flush（書き込みが止まったら、定期 flush を待たずに保存する）", () => {
  it("書き込みが止まると保存される", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { flushIntervalMs: 60_000, flushIdleMs: 20 });
    await store.write(0, Uint8Array.from([1, 2, 3]));
    await eventually(async () => (await env.instance.keys("o:")).length === 1, 2000);
    assert.equal(store.stats().pendingBytes, 0);
    await store.close();
  });

  it("書き込みが続いている間は flush せず、止まってから flush する", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const store = await openStore(image, env, { flushIntervalMs: 0, flushIdleMs: 150 });
    const before = env.instance.batchCalls;
    // 書き込みは合計でアイドル判定の時間（150ms）より長く続く。間隔（約 8ms）は、判定の時間よりずっと短い。
    // タイマーを書き込みのたびに延期していないと、続いている最中に flush が走ってこのテストが落ちる。
    const startedAt = Date.now();
    let writes = 0;
    while (Date.now() - startedAt < 400) {
      await store.write(0, Uint8Array.from([writes++ & 0xff]));
      await sleep(8);
    }
    assert.ok(writes > 10, `書き込みの回数が少なすぎます: ${writes}`);
    assert.equal(env.instance.batchCalls, before, "書き込みの最中に flush されました");
    await eventually(async () => (await env.instance.keys("o:")).length === 1, 3000);
    await store.close();
  });

  it("flush に失敗しても、書き込みが無いまま再試行され、最終的に保存される", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const env = newEnv(image);
    const errors: unknown[] = [];
    const store = await openStore(image, env, {
      flushIntervalMs: 0,
      flushIdleMs: 20,
      onError: (error) => errors.push(error),
    });
    env.instance.failBatches = 1;
    await store.write(0, Uint8Array.from([9]));
    await eventually(() => errors.length === 1, 2000);
    await eventually(async () => (await env.instance.keys("o:")).length === 1, 2000);
    assert.equal(store.stats().pendingBytes, 0);
    await store.close();
  });
});

/** batch が成功するたびに、その直後の中身を記録する KV。記録した一つ一つが「その瞬間に電源が落ちた場合の保存内容」。 */
class RecordingKV extends TestKV {
  readonly history: Array<Map<string, Uint8Array>> = [];

  override async batch(ops: readonly KVOp[]): Promise<void> {
    await super.batch(ops);
    const snapshot = new Map<string, Uint8Array>();
    for (const key of await this.keys("")) {
      const value = await this.get(key);
      if (value) snapshot.set(key, value);
    }
    this.history.push(snapshot);
  }
}

/** 記録した保存内容から、再起動後に見えるディスク全体を復元する。 */
async function diskAfterCrash(image: TestImage, snapshot: Map<string, Uint8Array>): Promise<Uint8Array> {
  const instance = new MemoryKV();
  await instance.batch([...snapshot].map(([key, value]): KVOp => ({ type: "put", key, value })));
  const store = await ChunkedBlockStore.open({
    manifest: image.manifest,
    source: new CountingSource(image),
    baseCache: new MemoryKV(),
    instance,
    flushIntervalMs: 0,
    readaheadChunks: 0,
  });
  return store.read(0, image.manifest.size);
}

/** persisted の各チャンクが、a か b のどちらかのチャンクと一致するか。 */
function chunkwiseEither(persisted: Uint8Array, a: Uint8Array, b: Uint8Array | undefined): boolean {
  for (let start = 0; start < persisted.length; start += CS) {
    const end = Math.min(start + CS, persisted.length);
    const p = persisted.subarray(start, end);
    const matchesA = Buffer.compare(p, a.subarray(start, end)) === 0;
    const matchesB = b !== undefined && Buffer.compare(p, b.subarray(start, end)) === 0;
    if (!matchesA && !matchesB) return false;
  }
  return true;
}

describe("クラッシュ時の一貫性", () => {
  it("どの瞬間に落ちても、保存済みの内容は『書き込みを先頭から k 個適用した状態』になる（進行中の 1 回だけは、チャンク単位で途中まで反映されうる）", async () => {
    const SEEDS = 25;
    const WRITES = 30;
    let crashPoints = 0;

    for (let seed = 1; seed <= SEEDS; seed++) {
      const image = await makeImage({ size: SIZE, chunkSize: CS, seed });
      const instance = new RecordingKV();
      const env: Env = { source: new CountingSource(image), baseCache: new TestKV(), instance };
      env.source.delayMs = 1; // 部分書き込みのための読み込みを非同期にして、flush と重なりやすくする
      instance.batchDelayMs = 1; // flush に時間をかけ、その間にも書き込みが来るようにする
      const store = await openStore(image, env, { memoryCacheBytes: 0 });

      const rnd = pseudoRandomBytes(4000, seed + 100);
      let cursor = 0;
      const next = () => rnd[cursor++ % rnd.length] ?? 0;

      // 書き込みを k 個適用した直後のディスク全体（モデル）
      const states: Uint8Array[] = [image.bytes.slice()];
      const pending: Promise<unknown>[] = [];
      for (let n = 0; n < WRITES; n++) {
        const offset = (next() * 256 + next()) % SIZE;
        const length = 1 + ((next() * 256 + next()) % Math.min(CS * 3, SIZE - offset)); // チャンクをまたぐ書き込みも含む
        const data = pseudoRandomBytes(length, seed * 1000 + n + 1);
        const state = at(states, states.length - 1).slice();
        state.set(data, offset);
        states.push(state);

        pending.push(store.write(offset, data));
        const r = next();
        if (r % 4 === 0) pending.push(store.flush().catch(() => {})); // flush は書き込みと並行していつ呼ばれてもよい
        if (r % 13 === 0) instance.failBatches = 1; // 保存の失敗も混ぜる
        if (r % 5 === 0) await sleep(1 + (r % 3));
      }
      await Promise.all(pending);
      instance.failBatches = 0;
      await store.flush();

      // 記録したすべての時点（= すべてのクラッシュ地点）を検査する
      let k = 0;
      for (const [index, snapshot] of instance.history.entries()) {
        const persisted = await diskAfterCrash(image, snapshot);
        let found = -1;
        for (let j = k; j < states.length; j++) {
          if (chunkwiseEither(persisted, at(states, j), states[j + 1])) {
            found = j;
            break;
          }
        }
        assert.ok(found >= 0, `seed=${seed}: ${index} 回目の保存直後の内容が、どの時点の状態とも合いません（k=${k} 以降）`);
        k = found; // 保存内容が古い状態に戻ることはない
        crashPoints++;
      }

      const last = at(instance.history, instance.history.length - 1);
      assert.deepEqual(await diskAfterCrash(image, last), at(states, states.length - 1), `seed=${seed}: 最後の flush で、すべての書き込みが保存されていません`);
    }

    assert.ok(crashPoints > SEEDS * 3, `検査したクラッシュ地点が少なすぎます: ${crashPoints}`);
  });
});
