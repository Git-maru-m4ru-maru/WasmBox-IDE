// ブラウザ上の v86 ゲスト（alpine.html）を Playwright から操作するための共通部品。
// alpine-smoke.mjs（起動・Node.js・Python）と persist-smoke.mjs（永続化）が使う。
import assert from "node:assert/strict";

export const PROMPT = "__WASMBX_PROMPT__ ";
export const ALPINE_URL = "http://127.0.0.1:8080/alpine.html";

/**
 * GitHub Actions の annotation として値を残す。
 * Actions のログは API から取れないことがあるが、annotation は check-runs API から読める。
 */
export function notice(title, value) {
  const message = typeof value === "string" ? value : JSON.stringify(value);
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log("::notice title=" + title + "::" + escaped);
}

/** 失敗の詳細を annotation（error）として残す。長すぎる場合は末尾を残して切り詰める。 */
export function failure(title, value, limit = 6000) {
  const message = typeof value === "string" ? value : JSON.stringify(value);
  const tail = message.length > limit ? "…(省略)…" + message.slice(-limit) : message;
  const escaped = tail.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log("::error title=" + title + "::" + escaped);
}

/**
 * page 上のゲストにシリアル経由でコマンドを送り、結果を受け取る操作一式を作る。
 * page.waitForFunction に渡す関数はブラウザ側で動くため、外の変数やヘルパーを参照できない
 * （ANSI エスケープの除去を各関数の中に書いているのはそのため）。
 */
export function createGuest(page) {
  async function sendCommand(command) {
    const previousPrompts = await page.evaluate((marker) => {
      const text = document.getElementById("serial")?.value ?? "";
      return text.split(marker).length - 1;
    }, PROMPT);

    await page.evaluate((text) => {
      const emulator = window.__wasmboxAlpineV86;
      if (!emulator || typeof emulator.serial0_send !== "function") {
        throw new Error("v86 のシリアル送信APIを取得できません");
      }
      emulator.serial0_send(text);
    }, command + "\n");

    await page.waitForFunction(
      ({ previous, marker }) => {
        const text = document.getElementById("serial")?.value ?? "";
        return text.split(marker).length - 1 > previous && text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").endsWith(marker);
      },
      { previous: previousPrompts, marker: PROMPT },
      { timeout: 60000 },
    );
    return page.locator("#serial").inputValue();
  }

  let commandId = 0;
  /**
   * コマンドを実行し、標準出力を返す。終了コードが 0 でなければ例外。
   * allowFailure を渡すと、失敗しても { exitCode, output } を返す（存在確認などに使う）。
   */
  async function run(label, command, { allowFailure = false, quiet = false } = {}) {
    commandId += 1;
    const beginToken = "__WASMBX_BEGIN_" + commandId + "__";
    const endToken = "__WASMBX_END_" + commandId + "__";
    const wrapped =
      "printf '\\n" + beginToken + "\\n'; " + command +
      "; code=$?; printf '\\n" + endToken + "%s\\n' \"$code\"";
    await sendCommand(wrapped);

    const terminal = await page.locator("#serial").inputValue();
    const begin = terminal.lastIndexOf(beginToken) + beginToken.length;
    const end = terminal.lastIndexOf(endToken);
    const exitCode = Number(terminal.slice(end + endToken.length).trim().split(/\r?\n/)[0]);
    const output = terminal.slice(begin, end).replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (!quiet) console.log("=== " + label + " (exit " + exitCode + ") ===\n" + output);
    if (allowFailure) return { exitCode, output };
    assert.equal(exitCode, 0, label + " failed:\n" + output);
    return output;
  }

  /**
   * 外付け initrd 経由の直接ルート起動を待ち、プロンプトを PROMPT に差し替えてシェルを使える状態にする。
   * startedAt（ms）からの経過時間を elapsedMs で返す。
   */
  async function waitForDirectRoot(timeout, startedAt = Date.now()) {
    await page.waitForFunction(() => {
      const terminal = document.getElementById("serial")?.value ?? "";
      const header = document.getElementById("boot-info")?.textContent ?? "";
      const failed = /Kernel panic|Unable to mount root fs|Run \/wasmbox-init as init process.*not found|initrd を取得できません/i.test(terminal + "\n" + header);
      const buildrootPrompt = terminal.includes("~% ");
      const directRootMarker = terminal.includes("[wasmbox-init] ルート:");
      const cleanTerminal = terminal.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
      const alpinePrompt = cleanTerminal.includes("wasmbox:~#") || cleanTerminal.endsWith("# ");
      return failed || buildrootPrompt || (header.includes("initrd あり") && (directRootMarker || alpinePrompt));
    }, null, { timeout });

    const header = await page.locator("#boot-info").textContent();
    const terminal = await page.locator("#serial").inputValue();
    assert.ok(header?.includes("initrd あり"), "外付け initrd が指定されていません: " + header);
    assert.ok(
      !terminal.includes("~% ") || terminal.includes("wasmbox:~#") || terminal.includes("[wasmbox-init] ルート:"),
      "Buildroot のシェルに留まっています。外付け initrd の rdinit が実行されていません:\n" + terminal.slice(-12000),
    );
    assert.ok(
      terminal.includes("[wasmbox-init] ルート:") || terminal.includes("wasmbox:~#") || terminal.endsWith("# "),
      "Alpine のシェルまたは initrd の起動ログに到達していません:\n" + terminal.slice(-12000),
    );

    const initMessage = terminal.match(/\[wasmbox-init\] ルート: \/dev\/(?:sda|hda)（ext4）/);
    console.log(initMessage ? "Initrd log: " + initMessage[0] : "Initrd log was not retained in textarea; direct-root state will be verified through /proc/mounts.");

    await page.evaluate((text) => {
      const emulator = window.__wasmboxAlpineV86;
      if (!emulator || typeof emulator.serial0_send !== "function") {
        throw new Error("v86 のシリアル送信APIを取得できません");
      }
      emulator.serial0_send(text);
    }, "export PS1='" + PROMPT + "'; echo __WASMBX_READY__\n");

    await page.waitForFunction(
      (marker) => {
        const terminal = document.getElementById("serial")?.value ?? "";
        return terminal.includes("__WASMBX_READY__") && terminal.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").endsWith(marker);
      },
      PROMPT,
      { timeout: 15000 },
    );

    return { header, terminal, elapsedMs: Date.now() - startedAt };
  }

  return { run, sendCommand, waitForDirectRoot };
}
