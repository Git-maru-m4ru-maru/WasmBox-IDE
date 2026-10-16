import { V86Engine } from "../src/engine/index.ts";
import {
  ChunkedBlockStore,
  HttpChunkSource,
  IdbKV,
  ManifestMismatchError,
  acquireInstanceLock,
  installAutoFlush,
  requestPersistentStorage,
  validateManifest,
} from "../src/storage/index.ts";
import { SAVE_STATE_LABEL, SaveStateTracker } from "./save-state.ts";
import type { SaveState } from "./save-state.ts";

const MiB = 1024 * 1024;
const COLS = 80;
const ROWS = 24;

const params = new URLSearchParams(location.search);
const memoryMiB = Number(params.get("memory") ?? "256");
const imageDir = (params.get("image") ?? "image").replace(/\/+$/, "");
// 自動テスト用: テストがターミナルの内容やストアの状態を読めるようにする
const smoke = params.get("smoke") === "1";

// 別のサイト（同じオリジンの別アプリ）や PoC のデータと混ざらないよう、専用の名前を使う
const INSTANCE_ID = "wasmbox";
const CACHE_DB = "wasmbox-app-cache";
const INSTANCE_DB = "wasmbox-app-instance";

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (!element) throw new Error("#" + id + " がありません");
  return element;
};

const overlay = $("overlay");
function showPhase(title: string, detail = "", kind: "progress" | "error" = "progress"): void {
  overlay.hidden = false;
  overlay.dataset["kind"] = kind;
  $("phase").textContent = title;
  $("phase-detail").textContent = detail;
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** 画面下のひとこと。persistent でなければ数秒で消える */
function notify(message: string, persistent = false): void {
  clearTimeout(noticeTimer);
  $("notice").textContent = message;
  if (!persistent && message) noticeTimer = setTimeout(() => ($("notice").textContent = ""), 4000);
}

function applySaveState(state: SaveState | "idle", label?: string): void {
  $("frame").dataset["save"] = state;
  const element = $("save-label");
  element.dataset["save"] = state;
  element.textContent = label ?? (state === "idle" ? "起動前" : SAVE_STATE_LABEL[state]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 幅に合わせて文字の大きさを決める（桁数は 80 で固定）。等幅フォントの字幅はおよそ 0.6em。 */
function fontSizeFor(width: number): number {
  return Math.max(10, Math.min(17, Math.floor(width / (COLS * 0.6))));
}

type Hooks = Window & { __wasmbox?: { term: Terminal; store: ChunkedBlockStore; engine: V86Engine } };

async function main(): Promise<void> {
  if (typeof V86 === "undefined") {
    showPhase("起動できません", "vendor/libv86.js を読み込めませんでした。tools/prepare-vendor.sh で用意してください。", "error");
    return;
  }
  if (typeof Terminal === "undefined") {
    showPhase("起動できません", "vendor/xterm.js を読み込めませんでした。tools/prepare-vendor.sh で用意してください。", "error");
    return;
  }
  if (!Number.isFinite(memoryMiB) || memoryMiB < 64 || memoryMiB > 2048) {
    showPhase("起動できません", "memory は 64〜2048（MiB）で指定してください: " + String(params.get("memory")), "error");
    return;
  }

  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", monospace',
    fontSize: fontSizeFor($("terminal").clientWidth),
    cursorBlink: true,
    scrollback: 2000,
    theme: { background: "#14172b", foreground: "#e6e4dc", cursor: "#f0b44c", selectionBackground: "#3b4a9c88" },
  });
  term.open($("terminal"));
  window.addEventListener("resize", () => {
    term.options.fontSize = fontSizeFor($("terminal").clientWidth);
  });

  showPhase("イメージを確認しています…");
  const manifestResponse = await fetch(imageDir + "/manifest.json", { cache: "no-store" });
  if (!manifestResponse.ok) {
    showPhase(
      "ディスクイメージが見つかりません",
      imageDir + "/manifest.json を取得できませんでした（HTTP " + manifestResponse.status + "）。",
      "error",
    );
    return;
  }
  const manifest = validateManifest(await manifestResponse.json());

  const initrdUrl = imageDir + "/initrd.cpio";
  const initrdHead = await fetch(initrdUrl, { method: "HEAD", cache: "no-store" }).catch(() => undefined);
  if (!initrdHead?.ok) {
    showPhase("起動用ファイルが見つかりません", initrdUrl + " を取得できませんでした。", "error");
    return;
  }

  showPhase("ブラウザの保存領域を開いています…");
  await requestPersistentStorage();
  let release: () => void;
  try {
    release = await acquireInstanceLock(INSTANCE_ID);
  } catch (error) {
    showPhase(
      "別のタブで開いています",
      "ディスクを壊さないよう、同時に開けるのは 1 つのタブだけです。\nもう一方のタブを閉じてから、このページを再読み込みしてください。\n（" + describeError(error) + "）",
      "error",
    );
    return;
  }
  window.addEventListener("pagehide", release);

  const baseCache = await IdbKV.open(CACHE_DB, { durability: "relaxed" });
  const instance = await IdbKV.open(INSTANCE_DB, { durability: "strict" });

  let resetting = false;
  let store: ChunkedBlockStore;
  try {
    store = await ChunkedBlockStore.open({
      manifest,
      source: new HttpChunkSource({
        layout: { kind: "chunk-files", urlFor: (_index, hash) => imageDir + "/chunks/" + hash },
      }),
      baseCache,
      instance,
      flushIntervalMs: 1000,
      // v86 はゲストの sync を伝えてこない。書き込みが 150ms 止まったら保存して、失われる範囲を縮める（ARCHITECTURE.md 4.3）
      flushIdleMs: 150,
      memoryCacheBytes: 32 * MiB,
      onError: (error) => {
        if (!resetting) notify("⚠️ ディスクへの保存に失敗しました: " + describeError(error), true);
      },
    });
  } catch (error) {
    if (error instanceof ManifestMismatchError) {
      showPhase(
        "ディスクイメージが新しくなっています",
        error.message + "\n「ディスクを初期化」を押すと、保存済みの書き込みを捨てて、新しいイメージで開けます。",
        "error",
      );
      enableReset(async () => {
        await ChunkedBlockStore.resetInstance(instance);
      });
      return;
    }
    throw error;
  }

  const engine = new V86Engine({
    V86,
    assets: {
      wasm: "vendor/v86.wasm",
      bios: "vendor/seabios.bin",
      vgaBios: "vendor/vgabios.bin",
      kernel: "vendor/kernel.bin",
      initrd: initrdUrl,
    },
    cmdline: "rdinit=/wasmbox-init root=/dev/sda rootfstype=ext4 rw rootwait console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
    onDiskError: (error) => {
      if (!resetting) notify("⚠️ ディスクの読み書きに失敗しました（ゲストが止まります）: " + describeError(error), true);
    },
  });
  installAutoFlush(engine, { onError: (error) => !resetting && notify("⚠️ 保存に失敗しました: " + describeError(error), true) });

  showPhase("Linux を起動しています…", "初回は、ディスクイメージを読み込むため時間がかかります（1〜2 分）。2 回目からは速く起動します。");
  // ゲストの最初の出力（カーネルの起動ログ）が届くまでは、案内を出しておく
  let firstOutput = true;
  const silentTimer = setTimeout(() => {
    if (firstOutput) {
      showPhase(
        "起動の反応がありません",
        "60 秒たっても、ゲストから出力がありません。vendor/ のファイル（v86.wasm、kernel.bin など）を読み込めていない可能性があります。ブラウザのコンソールを確認してください。",
        "error",
      );
    }
  }, 60_000);
  await engine.boot({
    disk: store,
    memoryMiB,
    onOutput: (data) => {
      if (firstOutput) {
        firstOutput = false;
        clearTimeout(silentTimer);
        overlay.hidden = true;
      }
      term.write(data);
    },
  });

  const encoder = new TextEncoder();
  term.onData((data) => {
    if (resetting) return;
    engine.input(encoder.encode(data));
  });
  term.focus();
  $("terminal").addEventListener("click", () => term.focus());

  $("info").textContent =
    "イメージ " + manifest.imageId + "（" + (manifest.size / MiB).toFixed(0) + " MiB）／ RAM " + memoryMiB + " MiB";

  const tracker = new SaveStateTracker();
  const refreshSaveState = () => applySaveState(tracker.update(store.stats()));
  refreshSaveState();
  setInterval(refreshSaveState, 500);

  const flushButton = $("flush") as HTMLButtonElement;
  flushButton.disabled = false;
  flushButton.addEventListener("click", () => {
    engine.flush().then(
      () => {
        refreshSaveState();
        notify("保存しました");
      },
      (error) => notify("⚠️ 保存に失敗しました: " + describeError(error), true),
    );
  });

  enableReset(async () => {
    resetting = true;
    try {
      // 捨てる内容なので、保存に失敗しても初期化は続ける
      await engine.dispose();
    } catch {
      // 無視
    }
    await store.close();
    await ChunkedBlockStore.resetInstance(instance);
  });

  if (smoke) (window as Hooks).__wasmbox = { term, store, engine };
}

/** 「ディスクを初期化」ボタンを使えるようにする。実際の初期化は reset が行い、終わったら再読み込みする。 */
function enableReset(reset: () => Promise<void>): void {
  const button = $("reset") as HTMLButtonElement;
  button.disabled = false;
  button.addEventListener("click", () => {
    if (!confirm("ディスクへの書き込みをすべて捨てて、初期状態に戻します。よろしいですか？")) return;
    button.disabled = true;
    reset().then(
      () => location.reload(),
      (error) => {
        button.disabled = false;
        notify("⚠️ 初期化に失敗しました: " + describeError(error), true);
      },
    );
  });
}

main().catch((error) => {
  showPhase("起動に失敗しました", describeError(error), "error");
});
