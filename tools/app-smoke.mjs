// 公開サイト（site/）のアプリを、実ブラウザ（Playwright の Chromium）で操作して確かめる。
//   確認すること: 起動して シェルが出る → キーボード入力が届く → Node.js が動く →
//                 書き込みが「保存済み」表示になる → ページを再読み込みしても残る →
//                 「ディスクを初期化」で消える。
// 前提: tools/serve.ts で site/ を http://127.0.0.1:8080/ に配信していること。
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { failure, notice } from "./smoke-lib.mjs";

const APP_URL = process.env.WASMBOX_APP_URL ?? "http://127.0.0.1:8080/index.html?smoke=1&memory=256";
const BOOT_TIMEOUT_MS = 240_000;
const COMMAND_TIMEOUT_MS = 60_000;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

/** ターミナルの画面（スクロールバックを含む）を、行ごとの配列で返す。行末の空白は除く。 */
const screenLines = () =>
  page.evaluate(() => {
    const buffer = window.__wasmbox.term.buffer.active;
    const lines = [];
    for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return lines;
  });

async function screenText() {
  return (await screenLines()).filter((line) => line.trim() !== "").join("\n");
}

/** 起動して、シェルのプロンプトが出るまで待つ。かかった時間（ms）を返す。 */
async function waitForShell(startedAt) {
  await page.waitForFunction(() => window.__wasmbox !== undefined, undefined, { timeout: BOOT_TIMEOUT_MS });
  await page.waitForFunction(
    () => {
      const buffer = window.__wasmbox.term.buffer.active;
      const lines = [];
      for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
      // Alpine のシェルのプロンプト（ホスト名 wasmbox）。外付け initrd の rescue シェルは "/ #" なので区別できる。
      // 起動ログ（"[wasmbox-init] … へ切り替えます"）は、画面に残らないことがある（CI で確認）。ルートが ext4 かは、あとで /proc/mounts で確かめる。
      const last = [...lines].reverse().find((line) => line.trim() !== "") ?? "";
      return /^wasmbox:\S*[#$]$/.test(last);
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS, polling: 500 },
  );
  return Date.now() - startedAt;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ターミナルにコマンドを打ち込み、出力に「expected と一致する行」が出るまで待つ。
 * expected が RegExp なら、その正規表現に合う行を待つ。
 * （打ち込んだコマンド自身もエコーされるので、期待する行は、コマンドの文字列とは別の行になるものにする）
 */
async function typeAndWait(command, expected, timeout = COMMAND_TIMEOUT_MS) {
  const source = expected instanceof RegExp ? expected.source : "^" + escapeRegExp(expected) + "$";
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (pattern) => {
      const regexp = new RegExp(pattern);
      const buffer = window.__wasmbox.term.buffer.active;
      for (let y = 0; y < buffer.length; y += 1) {
        if (regexp.test(buffer.getLine(y)?.translateToString(true) ?? "")) return true;
      }
      return false;
    },
    source,
    { timeout, polling: 250 },
  );
}

const storeStats = () => page.evaluate(() => window.__wasmbox.store.stats());

async function bootFresh(label) {
  const startedAt = Date.now();
  await page.goto(APP_URL, { waitUntil: "load" });
  const elapsed = await waitForShell(startedAt);
  await page.locator("#terminal").click();
  console.log(`${label}: シェルが出るまで ${(elapsed / 1000).toFixed(1)} 秒`);
  return elapsed;
}

const report = {};
try {
  // --- 1 回目の起動 ---
  report.boot1Seconds = Number(((await bootFresh("1 回目の起動")) / 1000).toFixed(1));

  await typeAndWait("echo ok_$((6*7))", "ok_42");
  await typeAndWait("grep -c ' / ext4 ' /proc/mounts | sed 's/^/root_ext4_lines=/'", "root_ext4_lines=1");
  await typeAndWait('node -e "console.log(111*7)"', "777");
  await typeAndWait("echo term=$TERM", /^term=\S*$/);
  report.term = (await screenLines()).find((line) => /^term=\S*$/.test(line)) ?? "(取得できず)";

  // 書き込み → sync → 保存済み表示（flush が走って未保存が 0 になる）
  const before = await storeStats();
  await typeAndWait("echo app_persisted_ok > /root/app-persist.txt && sync && echo synced", "synced");
  await page.waitForFunction(
    (flushes) => {
      const stats = window.__wasmbox.store.stats();
      return stats.pendingBytes === 0 && stats.flushes > flushes;
    },
    before.flushes,
    { timeout: 15_000 },
  );
  await page.waitForFunction(() => document.getElementById("save-label")?.dataset.save === "saved", undefined, { timeout: 5000 });
  report.saveLabel = (await page.locator("#save-label").textContent()) ?? "";
  assert.equal(await page.locator("#frame").getAttribute("data-save"), "saved");

  // 日本語入力（IME の確定文字は insertText として届く）。環境差があるので、結果は記録だけにする
  let japanese = false;
  try {
    await page.keyboard.insertText("echo あいう");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => {
        const buffer = window.__wasmbox.term.buffer.active;
        for (let y = 0; y < buffer.length; y += 1) {
          if ((buffer.getLine(y)?.translateToString(true) ?? "") === "あいう") return true;
        }
        return false;
      },
      undefined,
      { timeout: 8000, polling: 250 },
    );
    japanese = true;
  } catch {
    japanese = false;
  }
  report.japaneseInsertText = japanese;

  // --- 再読み込み: 保存した内容が残っている ---
  const boot2 = await bootFresh("再読み込み後の起動");
  report.boot2Seconds = Number((boot2 / 1000).toFixed(1));
  await typeAndWait("cat /root/app-persist.txt", "app_persisted_ok");

  // --- 初期化: 保存した内容が消える ---
  page.once("dialog", (dialog) => void dialog.accept());
  const startedAt = Date.now();
  await Promise.all([page.waitForNavigation({ timeout: COMMAND_TIMEOUT_MS }), page.click("#reset")]);
  const boot3 = await waitForShell(startedAt);
  report.boot3AfterResetSeconds = Number((boot3 / 1000).toFixed(1));
  await page.locator("#terminal").click();
  await typeAndWait("cat /root/app-persist.txt 2>&1 | grep -c 'No such file' | sed 's/^/missing_lines=/'", "missing_lines=1");

  assert.deepEqual(pageErrors, [], "ページでエラーが出ました: " + pageErrors.join(" / "));
  report.consoleErrors = consoleErrors.slice(0, 5);
  notice("WasmBox app", report);
  console.log("アプリの確認: すべて成功", JSON.stringify(report));
} catch (error) {
  const text = await screenText().catch(() => "(画面を取得できません)");
  failure("WasmBox app failure", String(error?.stack ?? error));
  failure("WasmBox app screen", text);
  failure("WasmBox app state", { report, pageErrors, consoleErrors: consoleErrors.slice(0, 10) });
  process.exitCode = 1;
} finally {
  await browser.close();
}
