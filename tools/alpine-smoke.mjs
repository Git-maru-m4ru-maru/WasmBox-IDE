import assert from "node:assert/strict";
import { chromium } from "playwright";
import { ALPINE_URL, createGuest, failure, notice } from "./smoke-lib.mjs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const { run, waitForDirectRoot } = createGuest(page);
const CYCLES = 3;
const measurements = [];

try {
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    const bootStartedAt = Date.now();
    await page.goto(ALPINE_URL + "?smoke=1&memory=256&cycle=" + cycle, { waitUntil: "load" });
    const boot = await waitForDirectRoot(120000, bootStartedAt);
    console.log("=== Direct-root boot cycle " + cycle + " ===");
    console.log("Shell ready: " + (boot.elapsedMs / 1000).toFixed(2) + " s");
    console.log("Boot options: " + boot.header);

    const rootMount = await run("Root mount", "grep -E '^[^ ]+ / ext4 ' /proc/mounts");
    assert.match(rootMount, /^\/dev\/(?:sda|hda) \/ ext4/m, "Alpine ext4 is not the actual root filesystem");

    await run("Kernel command line", "cat /proc/cmdline");
    const release = await run("Alpine release", "cat /etc/alpine-release");
    assert.match(release, /^3\.21\./);
    const nodeVersion = await run("Node.js version", "node --version");
    assert.match(nodeVersion, /^v\d+\.\d+\.\d+/);
    const nodeOutput = await run("Node.js execution", 'node -e "console.log(1 + 1)"');
    assert.match(nodeOutput, /(?:^|\n)2(?:\n|$)/);
    const pythonVersion = await run("Python version", "python3 --version");
    assert.match(pythonVersion, /^Python \d+\.\d+/);
    const memory = await run("Free memory after switch_root", "free -m");
    const nodeTiming = await run("Node.js startup time", 'time node -e "console.log(1)"');
    const pythonTiming = await run("Python startup time", 'time python3 -c "print(1)"');

    const memoryLine = memory.split(/\r?\n/).find((line) => /^Mem:\s/.test(line));
    const memoryValues = memoryLine?.match(/^Mem:\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+){0,2}\s+(\d+)$/);
    measurements.push({
      cycle,
      shellReadySeconds: Number((boot.elapsedMs / 1000).toFixed(2)),
      memoryTotalMiB: memoryValues ? Number(memoryValues[1]) : null,
      memoryUsedMiB: memoryValues ? Number(memoryValues[2]) : null,
      memoryFreeMiB: memoryValues ? Number(memoryValues[3]) : null,
      nodeTiming: nodeTiming.match(/real\s+([^\r\n]+)/)?.[1] ?? "not parsed",
      pythonTiming: pythonTiming.match(/real\s+([^\r\n]+)/)?.[1] ?? "not parsed",
      nodeVersion: nodeVersion.trim(),
      pythonVersion: pythonVersion.trim(),
    });

    console.log(JSON.stringify(measurements.at(-1), null, 2));
    await page.locator("#flush").click();
    await page.waitForTimeout(250);
  }

  assert.deepEqual(pageErrors, []);
  console.log("=== Direct-root startup summary ===");
  console.log(JSON.stringify(measurements, null, 2));
  // Actions のログは API から読めないことがあるため、実測値を annotation にも残す
  for (const m of measurements) notice("WasmBox boot cycle " + m.cycle, m);
  console.log("Three direct-root Alpine boots, Node.js, Python, and post-switch_root memory checks all passed.");
} catch (error) {
  const state = await page.evaluate(() => ({
    bootInfo: document.getElementById("boot-info")?.textContent,
    status: document.getElementById("status")?.textContent,
    serial: document.getElementById("serial")?.value.slice(-16000),
  })).catch(() => ({}));
  const detail = { error: String(error), pageErrors, state, measurements };
  console.error(JSON.stringify(detail, null, 2));
  failure("WasmBox Alpine smoke failed", detail);
  process.exitCode = 1;
} finally {
  await browser.close();
}
