import { BrowserIDE } from "./ide.ts";
import { createProjectTransferCommands } from "./ide-core.ts";
import type { ProjectFile } from "./ide-core.ts";

interface TerminalLine {
  translateToString(trimRight?: boolean): string;
}

interface TerminalBuffer {
  length: number;
  getLine(index: number): TerminalLine | undefined;
}

interface RuntimeTerminal {
  buffer: {
    active: TerminalBuffer;
  };
}

interface RuntimeEngine {
  input(data: Uint8Array): void;
}

interface WasmBoxHooks {
  term: RuntimeTerminal;
  engine: RuntimeEngine;
}

type RuntimeWindow = Window & {
  __wasmbox?: WasmBoxHooks;
};

const encoder = new TextEncoder();
const iframe = document.getElementById("linux-frame") as HTMLIFrameElement;
const status = document.getElementById("runtime-status") as HTMLElement;
const notice = document.getElementById("notice") as HTMLElement;
const outputPanel = document.getElementById("run-output-panel") as HTMLElement;
const output = document.getElementById("run-output") as HTMLPreElement;
const outputFileLabel = document.getElementById("output-file-label") as HTMLElement;

document.getElementById("output-close-button")?.addEventListener("click", () => {
  outputPanel.hidden = true;
});

let runtime: WasmBoxHooks | undefined;
let markerNumber = 0;
let stopping = false;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function notify(message: string, persistent = false): void {
  notice.textContent = message;
  notice.title = message;

  if (!persistent) {
    window.setTimeout(() => {
      if (notice.textContent === message) notice.textContent = "";
    }, 5000);
  }
}

function setRuntimeStatus(label: string, state: "booting" | "ready" | "error"): void {
  status.textContent = label;
  status.dataset["state"] = state;
}

function terminalText(): string {
  if (!runtime) return "";

  const buffer = runtime.term.buffer.active;
  const start = Math.max(0, buffer.length - 900);
  const lines: string[] = [];

  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }

  return lines.join("\n");
}

async function waitForRuntime(timeoutMs = 240_000): Promise<WasmBoxHooks> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const childWindow = iframe.contentWindow as RuntimeWindow | null;
      const hooks = childWindow?.__wasmbox;
      if (hooks?.engine && hooks.term) return hooks;
    } catch {
      // iframeの初期化中は次の確認まで待つ
    }

    await delay(250);
  }

  throw new Error("Linuxを起動できませんでした。再読み込みして、ブラウザのコンソールを確認してください。");
}

async function waitForMarker(marker: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (terminalText().split(/\r?\n/).some((line) => line.trim() === marker)) return;
    await delay(40);
  }

  throw new Error("Linuxから応答がありませんでした。ターミナルが起動しているか確認してください。");
}

async function sendCommand(command: string, timeoutMs = 30_000): Promise<void> {
  if (!runtime) throw new Error("Linuxの準備ができていません。");

  const marker = "WASMBOX_IDE_MARKER_" + Date.now() + "_" + (++markerNumber);
  const input = command + "; printf '\\n" + marker + "\\n'\n";
  runtime.engine.input(encoder.encode(input));
  await waitForMarker(marker, timeoutMs);
}

async function runProject(files: readonly ProjectFile[], activeFile: string): Promise<void> {
  runtime = await waitForRuntime();
  stopping = false;
  output.textContent = "";
  outputFileLabel.textContent = activeFile;
  outputPanel.hidden = false;

  await sendCommand("stty -echo", 60_000);
  const transfer = createProjectTransferCommands(files, activeFile);

  for (const command of transfer.commands) {
    if (stopping) throw new Error("実行を停止しました。");
    await sendCommand(command, 60_000);
  }

  if (stopping) return;

  const startMarker = "WASMBOX_IDE_OUTPUT_START_" + Date.now() + "_" + (++markerNumber);
  await sendCommand("printf '\\n" + startMarker + "\\n'");
  const beforeRun = terminalText();

  const endMarker = "WASMBOX_IDE_OUTPUT_END_" + Date.now() + "_" + (++markerNumber);
  runtime.engine.input(encoder.encode(transfer.runCommand + "; printf '\\n" + endMarker + "\\n'\n"));

  try {
    await waitForMarker(endMarker, 120_000);
  } catch (error) {
    if (!stopping) throw error;
  }

  const afterRun = terminalText();
  const startIndex = afterRun.lastIndexOf(startMarker);
  const endIndex = afterRun.lastIndexOf(endMarker);

  if (startIndex >= 0 && endIndex > startIndex) {
    output.textContent = afterRun.slice(startIndex + startMarker.length, endIndex).trim();
  } else if (afterRun.startsWith(beforeRun)) {
    output.textContent = afterRun.slice(beforeRun.length).trim();
  } else {
    output.textContent = afterRun.slice(-12_000);
  }

  notify(stopping ? "実行を停止しました。" : "実行が終了しました。");
}

const ide = new BrowserIDE({
  onRun: runProject,
  onStop: () => {
    stopping = true;
    runtime?.engine.input(Uint8Array.of(3));
  },
  onNotify: notify,
});

void ide.initialize();
setRuntimeStatus("Linuxを起動中…", "booting");
notify("Linuxを起動しています。初回は時間がかかることがあります。");

void waitForRuntime()
  .then((hooks) => {
    runtime = hooks;
    ide.setRunEnabled(true);
    setRuntimeStatus("Linux準備完了", "ready");
    notify("Linuxの準備ができました。Python・Node.js・Shellを実行できます。");
  })
  .catch((error: unknown) => {
    setRuntimeStatus("起動エラー", "error");
    notify(error instanceof Error ? error.message : String(error), true);
  });
