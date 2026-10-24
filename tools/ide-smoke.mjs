import assert from "node:assert/strict";
import { chromium } from "playwright";

const IDE_URL = process.env.WASMBOX_IDE_URL ?? "http://127.0.0.1:8080/ide.html";
const BOOT_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 120_000;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
const runResults = [];

page.on("pageerror", (error) => pageErrors.push(error.message));

const fileButton = (name) => page.locator("#file-tree .file-row").filter({ hasText: name }).first();

async function waitForRunButton(timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const button = document.getElementById("run-button");
      return Boolean(button && !button.hidden && !button.disabled);
    },
    undefined,
    { timeout },
  );
}

async function editFile(name, source) {
  await fileButton(name).click();
  const codeMirrorEditor = page.locator("#code-editor-cm .cm-content");
  if (await codeMirrorEditor.isVisible()) {
    await codeMirrorEditor.fill(source);
  } else {
    await page.locator("#code-editor").fill(source);
  }
}

async function runFile(name, source, expectedOutput) {
  await editFile(name, source);
  await waitForRunButton();
  await page.locator("#run-button").click();

  await page.waitForFunction(
    (expected) => document.getElementById("run-output")?.textContent?.includes(expected) === true,
    expectedOutput,
    { timeout: RUN_TIMEOUT_MS },
  );

  await waitForRunButton(RUN_TIMEOUT_MS);

  const output = (await page.locator("#run-output").textContent()) ?? "";
  assert.ok(output.includes(expectedOutput), `Expected output was missing for ${name}`);
  runResults.push({ file: name, expectedOutput });
}

const startedAt = Date.now();

try {
  await page.goto(IDE_URL, { waitUntil: "load" });

  await page.waitForFunction(
    () => document.getElementById("runtime-status")?.dataset.state === "ready",
    undefined,
    { timeout: BOOT_TIMEOUT_MS, polling: 250 },
  );

  await page.waitForFunction(
    () => {
      const engine = document.getElementById("editor-body")?.getAttribute("data-editor-engine");
      return engine === "codemirror" || engine === "textarea";
    },
    undefined,
    { timeout: 20_000 },
  );

  await waitForRunButton();
  const bootSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));

  await runFile("main.py", 'print("IDE_PYTHON_OK")\n', "IDE_PYTHON_OK");
  await runFile("main.js", 'console.log("IDE_NODE_OK")\n', "IDE_NODE_OK");

  await page.locator("#new-file-button").click();
  await page.locator("#new-file-name").fill("smoke.sh");
  await page.locator("#new-file-form button[type=submit]").click();
  await page.waitForFunction(
    () => document.getElementById("active-file-name")?.textContent === "smoke.sh",
    undefined,
    { timeout: 5_000 },
  );

  await runFile("smoke.sh", "printf 'IDE_SHELL_OK\\n'\n", "IDE_SHELL_OK");

  await editFile("main.py", 'print("IDE_PERSISTED_OK")\n');
  await page.locator("#save-button").click();
  await page.waitForFunction(
    () => document.getElementById("project-save-label")?.dataset.save === "saved",
    undefined,
    { timeout: 10_000 },
  );

  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const activeFile = document.getElementById("active-file-name")?.textContent;
      const editor = document.getElementById("code-editor");
      return activeFile === "main.py" && editor instanceof HTMLTextAreaElement &&
        editor.value === 'print("IDE_PERSISTED_OK")\n';
    },
    undefined,
    { timeout: 10_000 },
  );

  assert.deepEqual(pageErrors, [], "IDE page errors: " + pageErrors.join(" / "));
  console.log("WasmBox IDE smoke passed", JSON.stringify({ bootSeconds, runResults, persistedAfterReload: true, editorEngine: await page.locator("#editor-body").getAttribute("data-editor-engine") }));
} catch (error) {
  const details = {
    error: String(error?.stack ?? error),
    status: await page.locator("#runtime-status").textContent().catch(() => "(unavailable)"),
    notice: await page.locator("#notice").textContent().catch(() => "(unavailable)"),
    editorEngine: await page.locator("#editor-body").getAttribute("data-editor-engine").catch(() => "(unavailable)"),
    activeFile: await page.locator("#active-file-name").textContent().catch(() => "(unavailable)"),
    textareaValue: await page.locator("#code-editor").inputValue().catch(() => "(unavailable)"),
    codeMirrorText: await page.locator("#code-editor-cm .cm-content").innerText().catch(() => "(unavailable)"),
    output: await page.locator("#run-output").textContent().catch(() => "(unavailable)"),
    pageErrors,
    runResults,
  };
  console.error("WasmBox IDE smoke failed", JSON.stringify(details, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
