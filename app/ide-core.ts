export interface ProjectFile {
  name: string;
  content: string;
}

export interface ProjectState {
  files: ProjectFile[];
  activeFile: string;
}

export const DEFAULT_PROJECT: ProjectState = {
  files: [
    {
      name: "main.py",
      content: 'print("Hello from WasmBox IDE!")\n',
    },
    {
      name: "main.js",
      content: 'console.log("Hello from WasmBox IDE!");\n',
    },
    {
      name: "README.md",
      content: "# WasmBox IDE\n\nこのプロジェクトはブラウザ内のLinuxで実行されます。\n\n- Python: `main.py`\n- Node.js: `main.js`\n",
    },
  ],
  activeFile: "main.py",
};

export const MAX_FILES = 30;
export const MAX_FILE_BYTES = 32 * 1024;
export const MAX_PROJECT_BYTES = 64 * 1024;

export function validateFileName(name: string): string | undefined {
  if (name.length === 0 || name.length > 64) return "ファイル名は1〜64文字にしてください。";
  if (name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return "ファイル名には英数字、ピリオド、ハイフン、アンダースコアだけ使えます。";
  }
  if (name.startsWith("-") || name.startsWith(".")) {
    return "ファイル名の先頭にハイフンやピリオドは使えません。";
  }
  return undefined;
}

export function validateProjectState(state: ProjectState): string | undefined {
  if (!Array.isArray(state.files) || state.files.length === 0 || state.files.length > MAX_FILES) {
    return `ファイル数は1〜${MAX_FILES}個にしてください。`;
  }

  const names = new Set<string>();
  let totalBytes = 0;

  for (const file of state.files) {
    if (!file || typeof file.name !== "string" || typeof file.content !== "string") {
      return "プロジェクトのファイル形式が正しくありません。";
    }
    const nameError = validateFileName(file.name);
    if (nameError) return `${file.name}: ${nameError}`;
    if (names.has(file.name)) return `同じ名前のファイルがあります: ${file.name}`;
    names.add(file.name);

    const bytes = new TextEncoder().encode(file.content).byteLength;
    if (bytes > MAX_FILE_BYTES) return `${file.name} は32 KiBを超えています。`;
    totalBytes += bytes;
  }

  if (totalBytes > MAX_PROJECT_BYTES) return "プロジェクト全体は64 KiB以内にしてください。";
  if (!names.has(state.activeFile)) return "編集中のファイルがプロジェクトにありません。";
  return undefined;
}

export function runtimeForFile(name: string): string | undefined {
  if (/\.(py|pyw)$/i.test(name)) return "python3";
  if (/\.(js|mjs|cjs)$/i.test(name)) return "node";
  if (/\.sh$/i.test(name)) return "sh";
  return undefined;
}

export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const step = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }

  return btoa(binary);
}

export interface ProjectTransferCommands {
  commands: string[];
  runCommand: string;
}

export function createProjectTransferCommands(
  files: readonly ProjectFile[],
  activeFile: string,
): ProjectTransferCommands {
  const state: ProjectState = { files: [...files], activeFile };
  const problem = validateProjectState(state);
  if (problem) throw new Error(problem);

  const runtime = runtimeForFile(activeFile);
  if (!runtime) throw new Error("実行できるのは .py、.js、.mjs、.cjs、.sh ファイルです。");

  const commands = ["rm -rf /tmp/wasmbox-ide-project && mkdir -p /tmp/wasmbox-ide-project"];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;
    const encodedPath = `/tmp/wasmbox-ide-project/.upload-${index}.b64`;
    const targetPath = `/tmp/wasmbox-ide-project/${file.name}`;
    const content = base64Utf8(file.content);
    commands.push(`: > '${encodedPath}'`);

    for (let offset = 0; offset < content.length; offset += 1600) {
      const chunk = content.slice(offset, offset + 1600);
      commands.push(`printf '%s' '${chunk}' >> '${encodedPath}'`);
    }

    commands.push(`base64 -d '${encodedPath}' > '${targetPath}' && rm -f '${encodedPath}'`);
  }

  const runCommand =
    `cd /tmp/wasmbox-ide-project; printf '\\n[WasmBox IDE] Running: %s\\n\\n' '${activeFile}'; ` +
    `${runtime} '${activeFile}'; result=$?; ` +
    `printf '\\n[WasmBox IDE] Exit code: %s\\n' "$result"`;

  return { commands, runCommand };
}
