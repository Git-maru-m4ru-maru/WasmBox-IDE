// ブラウザ自己診断（poc/selftest.html）を、Chromium・Firefox・WebKit で実行する。
//   ① ?phase=write（読み書き → flush）→ ② 同じブラウザで ?phase=verify（開き直したあとも残っているか）
// 前提: npm run poc:build のあと、npm run poc:serve（http://127.0.0.1:8080/）が動いていること。
//
// 注意: Playwright の WebKit は、Safari そのものではない（同じエンジンの別ビルド）。結果を「Safari で確認した」と書かないこと。
// Chromium が失敗したら終了コード 1。Firefox / WebKit の失敗は警告として残す（最初の結果を見てから、必須にするか決める）。
import { chromium, firefox, webkit } from "playwright";
import { failure, notice } from "./smoke-lib.mjs";

const BASE = process.env.WASMBOX_POC_URL ?? "http://127.0.0.1:8080/selftest.html";
const BROWSERS = [
  { name: "Chromium", type: chromium, required: true },
  { name: "Firefox", type: firefox, required: false },
  { name: "WebKit（Playwright 版。Safari ではない）", type: webkit, required: false },
];

async function runPhase(page, phase) {
  await page.goto(`${BASE}?phase=${phase}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__selftest?.done === true, undefined, { timeout: 60_000 });
  return page.evaluate(() => window.__selftest);
}

const summary = [];
let requiredFailed = false;

for (const { name, type, required } of BROWSERS) {
  const entry = { browser: name, version: "", passed: 0, failed: [], error: undefined };
  summary.push(entry);
  let browser;
  try {
    browser = await type.launch({ headless: true });
    entry.version = browser.version();
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    entry.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");

    for (const phase of ["write", "verify"]) {
      const result = await runPhase(page, phase);
      for (const item of result.results) {
        if (item.ok) entry.passed += 1;
        else entry.failed.push(`[${phase}] ${item.name} → ${item.detail ?? ""}`);
      }
    }
    if (pageErrors.length > 0) entry.failed.push("ページのエラー: " + pageErrors.join(" / "));
  } catch (error) {
    entry.error = String(error?.stack ?? error);
  } finally {
    await browser?.close();
  }

  const ok = entry.failed.length === 0 && entry.error === undefined;
  console.log(`${ok ? "✅" : "❌"} ${name} ${entry.version}: ${entry.passed} 件成功${ok ? "" : "、失敗あり"}`);
  if (!ok) {
    const detail = { failed: entry.failed, error: entry.error };
    if (required) {
      requiredFailed = true;
      failure(`WasmBox selftest ${name}`, detail);
    } else {
      console.log(`::warning title=WasmBox selftest ${name}::${JSON.stringify(detail).replace(/%/g, "%25").replace(/\n/g, "%0A").slice(0, 3000)}`);
    }
  }
}

notice("WasmBox browsers", summary);
if (requiredFailed) process.exitCode = 1;
