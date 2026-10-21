// M3: ディスクの永続化を、実ブラウザ + v86 + Alpine で確認する。
//
// 確認すること（✅ は失敗したらテストが落ちる、📝 は結果を記録するだけ）
//   ✅ アイドル flush（書き込みが 150ms 止まったら保存）だけで、ファイルが保存され、
//      ブラウザを完全に閉じて開き直したあとも残っている（定期 flush は 60 秒に延ばして効かせない）
//   ✅ 開き直したあとも、ext4 のルートで起動できる（保存前に閉じたあとのジャーナル回復を含む）
//   ✅ 明示的に flush してからリロードしたファイルが残っている
//   📝 ゲストの sync 直後（定期 flush の前）にページを閉じたとき、そのファイルが残るか
//   📝 sync 直後にリロードしたとき、pagehide の flush だけで残るか
//
// v86 の IDE は FLUSH CACHE を何もせずに完了する（ディスクには届かない）ため、
// ゲストの sync は IndexedDB への保存を保証しない。ここで測るのは、その「失われうる範囲」。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ALPINE_URL, createGuest, failure, notice } from "./smoke-lib.mjs";

/** poc/alpine.ts の定期 flush は 1000 ms。余裕を見て待つ。 */
const FLUSH_WAIT_MS = 2500;
const token = Date.now().toString(36);
const profileDir = await mkdtemp(join(tmpdir(), "wasmbox-profile-"));
const report = {};

async function openSession() {
  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  const page = context.pages()[0] ?? (await context.newPage());
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { context, page, pageErrors, guest: createGuest(page) };
}

/** alpine.html を開いて、直接ルート起動したシェルが使えるようになるまで待つ。 */
async function boot(session, extraQuery = "") {
  const startedAt = Date.now();
  await session.page.goto(ALPINE_URL + "?smoke=1&memory=256" + extraQuery, { waitUntil: "load" });
  return afterNavigation(session, startedAt);
}

async function reload(session) {
  const startedAt = Date.now();
  await session.page.reload({ waitUntil: "load" });
  return afterNavigation(session, startedAt);
}

async function afterNavigation(session, startedAt) {
  const result = await session.guest.waitForDirectRoot(120000, startedAt);
  const stats = await session.page.evaluate(() => window.__wasmboxAlpineStore?.stats());
  const rootMount = await session.guest.run("Root mount", "grep -E '^[^ ]+ / ext4 ' /proc/mounts", { quiet: true });
  assert.match(rootMount, /^\/dev\/(?:sda|hda) \/ ext4/m, "ext4 がルートになっていません: " + rootMount);
  return {
    seconds: Number((result.elapsedMs / 1000).toFixed(2)),
    networkFetches: stats?.networkFetches,
    baseCacheHits: stats?.baseCacheHits,
    overlayChunks: stats?.overlayChunks,
  };
}

/** ゲストにファイルを書いて sync する。 */
function writeFile(session, name, content) {
  return session.guest.run("write " + name, "echo " + content + " > /root/" + name + " && sync");
}

async function readFile(session, name) {
  const { exitCode, output } = await session.guest.run("read " + name, "cat /root/" + name, { allowFailure: true });
  return exitCode === 0 ? output : null;
}

/** 定期 flush が確実に回るまで待ち、未保存の書き込みが無くなったことを確かめる。 */
async function waitForDurable(session) {
  await session.page.waitForTimeout(FLUSH_WAIT_MS);
  await session.page.waitForFunction(
    () => {
      const stats = window.__wasmboxAlpineStore?.stats();
      return !!stats && stats.pendingBytes === 0;
    },
    null,
    { timeout: 30000 },
  );
}

let session;
try {
  // ---- セッション1: 初回起動。アイドル flush だけを頼りにする
  //      pagehide の flush は外し、定期 flush は 60 秒に延ばす（= 保存されたなら、アイドル flush が働いた証拠）
  session = await openSession();
  report.coldBoot = await boot(session, "&autoflush=off&flushinterval=60000&flushidle=150");
  const contentA = "A-" + token;
  const contentE = "E-" + token;
  const contentB = "B-" + token;
  await writeFile(session, "a.txt", contentA);
  await waitForDurable(session);

  // 書き込み → 保存済みになるまでの時間を測る。アイドル flush が無ければ、60 秒の定期 flush まで保存されない。
  await writeFile(session, "e.txt", contentE);
  const idleStartedAt = Date.now();
  await session.page.waitForFunction(
    () => (window.__wasmboxAlpineStore?.stats().pendingBytes ?? 1) === 0,
    null,
    { timeout: 5000, polling: 25 },
  );
  report.idleFlushLatencyMs = Date.now() - idleStartedAt;
  await session.page.waitForTimeout(300); // 書き込みがストアに届く前に 0 を見ていた場合に備え、少し待つ

  await writeFile(session, "b.txt", contentB);
  // ここでは待たずに閉じる。sync は済んでいるが、IndexedDB への保存は（アイドル flush が働く前に）間に合わない
  report.pendingBytesAtClose = (await session.page.evaluate(() => window.__wasmboxAlpineStore?.stats().pendingBytes)) ?? null;
  await session.context.close();
  session = undefined;

  // ---- セッション2: ブラウザを開き直す（同じプロファイル = 同じ IndexedDB）
  session = await openSession();
  report.warmBoot = await boot(session);

  assert.equal(await readFile(session, "a.txt"), contentA, "アイドル flush で保存したはずの a.txt が、開き直したあと残っていません");
  assert.equal(await readFile(session, "e.txt"), contentE, "アイドル flush で保存したはずの e.txt が、開き直したあと残っていません");
  report.aAndESurvivedClose = true;
  report.bSurvivedAbruptClose = (await readFile(session, "b.txt")) === contentB;
  const kernelLog = await session.guest.run("ext4 のカーネルログ", "dmesg | grep -iE 'ext4|jbd2|recover' | tail -n 8", { allowFailure: true, quiet: true });
  report.ext4Log = kernelLog.output.split(/\r?\n/).slice(-4);

  // ---- 明示的に flush してからリロード
  const contentC = "C-" + token;
  await writeFile(session, "c.txt", contentC);
  await session.page.locator("#flush").click();
  await waitForDurable(session);
  report.reloadAfterFlush = await reload(session);
  assert.equal(await readFile(session, "a.txt"), contentA, "リロード後に a.txt が残っていません");
  assert.equal(await readFile(session, "c.txt"), contentC, "flush 済みの c.txt が、リロード後に残っていません");
  report.cSurvivedReload = true;

  // ---- sync の直後にリロード（pagehide の flush だけが頼り）
  const contentD = "D-" + token;
  await writeFile(session, "d.txt", contentD);
  report.reloadWithoutFlush = await reload(session);
  assert.equal(await readFile(session, "c.txt"), contentC, "2回目のリロード後に c.txt が残っていません");
  report.dSurvivedImmediateReload = (await readFile(session, "d.txt")) === contentD;

  assert.deepEqual(session.pageErrors, []);
  console.log("=== 永続化の確認結果 ===\n" + JSON.stringify(report, null, 2));
  notice("WasmBox persistence", report);
  console.log("ブラウザの開き直し・flush 後のリロードで、ゲストが書いたファイルが残ることを確認しました。");
} catch (error) {
  const state = await session?.page
    .evaluate(() => ({
      status: document.getElementById("status")?.textContent,
      serial: document.getElementById("serial")?.value.slice(-12000),
    }))
    .catch(() => ({}));
  const detail = { error: String(error), report, state };
  console.error(JSON.stringify(detail, null, 2));
  failure("WasmBox persistence failed", detail);
  process.exitCode = 1;
} finally {
  await session?.context.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
