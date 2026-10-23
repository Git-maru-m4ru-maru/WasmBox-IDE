import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROJECT,
  MAX_FILE_BYTES,
  MAX_PROJECT_BYTES,
  base64Utf8,
  createProjectTransferCommands,
  runtimeForFile,
  validateFileName,
  validateProjectState,
} from "../app/ide-core.ts";

function decodeBase64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

test("初期プロジェクトは有効で、Pythonファイルを選択している", () => {
  assert.equal(validateProjectState(structuredClone(DEFAULT_PROJECT)), undefined);
  assert.equal(DEFAULT_PROJECT.activeFile, "main.py");
});

test("ファイル名はパス区切りやシェル用の記号を拒否する", () => {
  assert.equal(validateFileName("hello.py"), undefined);
  assert.match(validateFileName("../secret.py") ?? "", /ファイル名/);
  assert.match(validateFileName("x;id") ?? "", /ファイル名/);
  assert.match(validateFileName("-danger.sh") ?? "", /先頭/);
});


test("ファイル名はシェル展開やコマンド区切りに使える文字を拒否する", () => {
  for (const name of [
    "$(touch pwned).py",
    "`touch pwned`.py",
    "x'y.py",
    "x|id.py",
    "x name.py",
    "x\nid.py",
  ]) {
    assert.notEqual(validateFileName(name), undefined, name);
  }
});

test("拡張子ごとに利用するランタイムを選ぶ", () => {
  assert.equal(runtimeForFile("main.py"), "python3");
  assert.equal(runtimeForFile("app.MJS"), "node");
  assert.equal(runtimeForFile("build.sh"), "sh");
  assert.equal(runtimeForFile("README.md"), undefined);
});

test("Base64変換は日本語と絵文字を保持する", () => {
  const source = 'print("こんにちは 🌏")\n';
  assert.equal(decodeBase64Utf8(base64Utf8(source)), source);
});

test("ファイル転送コマンドは内容をBase64化し、選択ファイルのランタイムを指定する", () => {
  const source = 'print("実行テスト")\n';
  const transfer = createProjectTransferCommands([{ name: "main.py", content: source }], "main.py");
  assert.ok(transfer.commands.some((command) => command.includes("base64 -d")));
  assert.match(transfer.runCommand, /python3 'main.py'/);
  assert.ok(transfer.commands.every((command) => !command.includes("実行テスト")));
});

test("転送コマンドは1行4096バイト未満に分割される", () => {
  const source = "日本語データ🌏".repeat(1000);
  const transfer = createProjectTransferCommands([{ name: "main.py", content: source }], "main.py");
  assert.ok(transfer.commands.length > 3);
  assert.ok(transfer.commands.every((command) => new TextEncoder().encode(command).byteLength < 4096));
});

test("転送コマンドはパストラバーサルと実行対象外のファイルを拒否する", () => {
  assert.throws(() => createProjectTransferCommands([{ name: "../main.py", content: "x" }], "../main.py"), /ファイル名/);
  assert.throws(() => createProjectTransferCommands([{ name: "README.md", content: "text" }], "README.md"), /実行できるのは/);
});

test("ファイル単位とプロジェクト全体のサイズ制限を適用する", () => {
  const tooLargeFile = "a".repeat(MAX_FILE_BYTES + 1);
  assert.match(validateProjectState({ files: [{ name: "main.py", content: tooLargeFile }], activeFile: "main.py" }) ?? "", /32 KiB/);

  const oneFileSize = Math.floor(MAX_PROJECT_BYTES / 3) + 1;
  assert.match(validateProjectState({
    files: [
      { name: "main.py", content: "a".repeat(oneFileSize) },
      { name: "other.py", content: "b".repeat(oneFileSize) },
      { name: "third.py", content: "c".repeat(oneFileSize) },
    ],
    activeFile: "main.py",
  }) ?? "", /64 KiB/);
});
