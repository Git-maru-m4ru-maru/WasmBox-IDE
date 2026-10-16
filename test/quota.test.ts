import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { KVOp } from "../src/storage/types.ts";
import { CountingSource, TestKV, makeImage, openStore } from "./helpers.ts";
import type { Env, TestImage } from "./helpers.ts";

const CS = 4096;
// 24 チャンク
const SIZE = CS * 24;

/** 複数の KV で共有する容量。IndexedDB の容量（クォータ）は、オリジン全体で共有されるため。 */
class QuotaPool {
  capacity = Number.POSITIVE_INFINITY;
  readonly kvs: QuotaKV[] = [];
  get used(): number {
    return this.kvs.reduce((sum, kv) => sum + kv.bytes, 0);
  }
}

/** 共有容量を超える書き込みを、IndexedDB と同じ QuotaExceededError で断る KV */
class QuotaKV extends TestKV {
  bytes = 0;
  #sizes = new Map<string, number>();
  readonly #pool: QuotaPool;

  constructor(pool: QuotaPool) {
    super();
    this.#pool = pool;
    pool.kvs.push(this);
  }

  override async batch(ops: readonly KVOp[]): Promise<void> {
    const sizes = new Map(this.#sizes);
    let delta = 0;
    for (const op of ops) {
      const before = sizes.get(op.key) ?? 0;
      if (op.type === "put") {
        sizes.set(op.key, op.value.byteLength);
        delta += op.value.byteLength - before;
      } else {
        sizes.delete(op.key);
        delta -= before;
      }
    }
    if (delta > 0 && this.#pool.used + delta > this.#pool.capacity) {
      throw new DOMException("容量が足りません", "QuotaExceededError");
    }
    await super.batch(ops);
    this.#sizes = sizes;
    this.bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  }
}

function quotaEnv(image: TestImage): { env: Env; pool: QuotaPool; baseCache: QuotaKV; instance: QuotaKV } {
  const pool = new QuotaPool();
  const baseCache = new QuotaKV(pool);
  const instance = new QuotaKV(pool);
  return { env: { source: new CountingSource(image), baseCache, instance }, pool, baseCache, instance };
}

const chunkOf = (fill: number) => new Uint8Array(CS).fill(fill);
const readChunk = (store: { read(offset: number, length: number): Promise<Uint8Array> }, index: number) =>
  store.read(index * CS, CS);

describe("容量不足（QuotaExceededError）のとき、base キャッシュを捨てて overlay を保存する", () => {
  it("base キャッシュを捨てて、保存をやり直す。overlay の内容は失われない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const { env, pool, instance } = quotaEnv(image);
    const store = await openStore(image, env);
    for (let i = 0; i < 6; i++) await readChunk(store, i); // base キャッシュに 6 チャンク
    pool.capacity = 7 * CS + 1024; // overlay 1 チャンクぶんの余裕しかない

    await store.write(6 * CS, chunkOf(0xaa));
    await store.flush();
    assert.equal(store.stats().baseEvictions, 0, "容量に余裕があるうちは、何も捨てない");

    await store.write(7 * CS, chunkOf(0xbb));
    await store.flush(); // ここで容量不足 → base を捨てて再試行
    assert.equal(store.stats().pendingBytes, 0);
    assert.equal(store.stats().flushErrors, 0, "やり直しで成功したので、失敗として数えない");
    assert.equal(store.stats().baseEvictions, 6);
    assert.deepEqual(await instance.keys("o:"), ["o:6", "o:7"]);

    // 開き直しても、書いた内容が読める
    const reopened = await openStore(image, env);
    assert.deepEqual(await readChunk(reopened, 6), chunkOf(0xaa));
    assert.deepEqual(await readChunk(reopened, 7), chunkOf(0xbb));
  });

  it("このセッションで使っていない base チャンクを先に捨てる", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const { env, pool, baseCache } = quotaEnv(image);

    // 前のセッションが、チャンク 12〜21 を base キャッシュに残した
    const previous = await openStore(image, env);
    for (let i = 12; i < 22; i++) await readChunk(previous, i);
    await previous.close();
    assert.equal(baseCache.entryCount, 10);

    // 今のセッションは、チャンク 0〜2 を使っている
    const store = await openStore(image, env);
    for (let i = 0; i < 3; i++) await readChunk(store, i);
    assert.equal(baseCache.entryCount, 13);
    pool.capacity = pool.used + 1000; // 次の書き込みは入らない

    await store.write(23 * CS, chunkOf(0xcc));
    await store.flush();
    assert.equal(store.stats().baseEvictions, 8, "最低 8 チャンクを捨てる");
    const left = await baseCache.keys("h:");
    assert.equal(left.length, 5);
    for (let i = 0; i < 3; i++) {
      const hash = image.manifest.chunks[i];
      assert.ok(hash && left.includes("h:" + hash), `使っているチャンク ${i} は残す`);
    }
  });

  it("捨てるものがないときは、失敗を呼び出し元に伝える。保存待ちの内容と、保存済みの overlay は失わない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const { env, pool, instance } = quotaEnv(image);
    const store = await openStore(image, env);
    pool.capacity = instance.bytes + CS + 1024;

    await store.write(6 * CS, chunkOf(0x11));
    await store.flush();
    await store.write(7 * CS, chunkOf(0x22));
    await assert.rejects(store.flush(), (error: unknown) => (error as Error).name === "QuotaExceededError");
    assert.equal(store.stats().baseEvictions, 0);
    assert.equal(store.stats().flushErrors, 1);
    assert.equal(store.stats().pendingBytes, CS, "保存できなかった内容は、保存待ちに戻っている");
    assert.deepEqual(await instance.keys("o:"), ["o:6"], "保存済みの overlay は残っている");
    assert.deepEqual(await readChunk(store, 7), chunkOf(0x22), "保存待ちの内容は読める");

    pool.capacity = Number.POSITIVE_INFINITY; // 容量が空いた
    await store.flush();
    assert.equal(store.stats().pendingBytes, 0);
    assert.deepEqual(await instance.keys("o:"), ["o:6", "o:7"]);
  });

  it("容量不足以外の失敗では、base キャッシュを捨てない", async () => {
    const image = await makeImage({ size: SIZE, chunkSize: CS });
    const { env, baseCache, instance } = quotaEnv(image);
    const store = await openStore(image, env);
    for (let i = 0; i < 4; i++) await readChunk(store, i);
    assert.equal(baseCache.entryCount, 4);

    instance.failBatches = 1; // 「注入された書き込み失敗」（QuotaExceededError ではない）
    await store.write(6 * CS, chunkOf(0x33));
    await assert.rejects(store.flush(), /注入された書き込み失敗/);
    assert.equal(baseCache.entryCount, 4);
    assert.equal(store.stats().baseEvictions, 0);

    await store.flush(); // 再試行は成功する
    assert.deepEqual(await instance.keys("o:"), ["o:6"]);
  });
});
