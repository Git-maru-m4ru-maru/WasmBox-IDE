import {
  DEFAULT_PROJECT,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PROJECT_BYTES,
  runtimeForFile,
  validateFileName,
  validateProjectState,
} from "./ide-core.ts";
import type { ProjectFile, ProjectState } from "./ide-core.ts";
import { loadProjectState, saveProjectState } from "./project-store.ts";

interface CodeMirrorDocument {
  length: number;
  toString(): string;
}

interface CodeMirrorUpdate {
  docChanged: boolean;
  state: { doc: { toString(): string } };
}

interface CodeMirrorEditorView {
  state: { doc: CodeMirrorDocument };
  dom: HTMLElement;
  dispatch(transaction: {
    changes?: { from: number; to: number; insert: string };
    effects?: unknown[];
  }): void;
  focus(): void;
}

interface CodeMirrorCompartment {
  of(extension: unknown): unknown;
  reconfigure(extension: unknown): unknown;
}

interface CodeMirrorCore {
  basicSetup: unknown;
  EditorView: {
    new(config: { parent: HTMLElement; state: unknown }): CodeMirrorEditorView;
    updateListener: {
      of(listener: (update: CodeMirrorUpdate) => void): unknown;
    };
    theme(spec: Record<string, unknown>): unknown;
  };
}

interface CodeMirrorStateModule {
  EditorState: {
    create(config: { doc: string; extensions: unknown[] }): unknown;
  };
  Compartment: new () => CodeMirrorCompartment;
}

interface CodeMirrorLanguages {
  python: () => unknown;
  javascript: (options?: { jsx?: boolean; typescript?: boolean }) => unknown;
  html: () => unknown;
  css: () => unknown;
  json: () => unknown;
  markdown: () => unknown;
}

export interface BrowserIDEOptions {
  onRun: (files: readonly ProjectFile[], activeFile: string) => Promise<void>;
  onStop: () => void;
  onNotify: (message: string, persistent?: boolean) => void;
}

export class BrowserIDE {
  readonly #options: BrowserIDEOptions;
  #state: ProjectState = structuredClone(DEFAULT_PROJECT);
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #isRunning = false;
  #runEnabled = false;
  #saving = false;
  #saveAgain = false;
  #codeMirrorView: CodeMirrorEditorView | undefined;
  #languageCompartment: CodeMirrorCompartment | undefined;
  #codeMirrorLanguages: CodeMirrorLanguages | undefined;
  #syncingCodeMirror = false;

  constructor(options: BrowserIDEOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    try {
      this.#state = await loadProjectState();
    } catch (error) {
      this.#options.onNotify("プロジェクトの保存領域を開けませんでした。編集中の内容は、このタブを閉じるまで保持されます。", true);
      console.error(error);
    }

    this.#wireControls();
    this.#renderFiles();
    this.#renderEditor();
    this.#updateRunButtons();
    this.#setProjectSaveLabel("保存済み", "saved");
    void this.#initializeCodeMirror();
  }

  setRunEnabled(enabled: boolean): void {
    this.#runEnabled = enabled;
    this.#updateRunButtons();
  }

  #element<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`#${id} がありません`);
    return element as T;
  }

  #wireControls(): void {
    const editor = this.#element<HTMLTextAreaElement>("code-editor");
    editor.addEventListener("input", () => {
      const file = this.#activeFile();
      if (!file) return;
      file.content = editor.value;
      this.#renderLineNumbers();
      this.#setProjectSaveLabel("未保存", "pending");
      this.#scheduleSave();
    });

    editor.addEventListener("scroll", () => {
      this.#element<HTMLElement>("line-numbers").scrollTop = editor.scrollTop;
    });

    editor.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.setRangeText("  ", start, end, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.saveNow();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void this.runSelected();
      }
    });

    this.#element<HTMLButtonElement>("new-file-button").addEventListener("click", () => this.#openNewFileForm());
    this.#element<HTMLButtonElement>("new-file-cancel").addEventListener("click", () => this.#closeNewFileForm());
    this.#element<HTMLFormElement>("new-file-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.#createFile();
    });
    this.#element<HTMLButtonElement>("save-button").addEventListener("click", () => void this.saveNow());
    this.#element<HTMLButtonElement>("run-button").addEventListener("click", () => void this.runSelected());
    this.#element<HTMLButtonElement>("stop-button").addEventListener("click", () => this.#options.onStop());
    this.#element<HTMLButtonElement>("export-project-button").addEventListener("click", () => this.#exportProject());
    this.#element<HTMLButtonElement>("import-project-button").addEventListener("click", () => this.#element<HTMLInputElement>("import-project-input").click());
    this.#element<HTMLInputElement>("import-project-input").addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void this.#importProject(file);
    });
  }

  #activeFile(): ProjectFile | undefined {
    return this.#state.files.find((file) => file.name === this.#state.activeFile);
  }

  #renderFiles(): void {
    const tree = this.#element<HTMLElement>("file-tree");
    tree.replaceChildren();

    for (const file of this.#state.files) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-row" + (file.name === this.#state.activeFile ? " active" : "");
      button.setAttribute("aria-current", file.name === this.#state.activeFile ? "page" : "false");

      const icon = document.createElement("span");
      icon.className = "file-type-icon " + this.#fileIconClass(file.name);
      icon.textContent = this.#fileIconLabel(file.name);

      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.name;

      button.append(icon, name);
      button.addEventListener("click", () => {
        this.#state.activeFile = file.name;
        this.#renderFiles();
        this.#renderEditor();
        this.#scheduleSave();
      });
      tree.append(button);
    }

    this.#element<HTMLElement>("file-count").textContent = `${this.#state.files.length} files`;
  }

  #fileIconClass(name: string): string {
    if (/\.pyw?$/i.test(name)) return "python";
    if (/\.(m?js|cjs)$/i.test(name)) return "javascript";
    if (/\.sh$/i.test(name)) return "shell";
    if (/\.json$/i.test(name)) return "json";
    if (/\.html?$/i.test(name)) return "html";
    if (/\.css$/i.test(name)) return "css";
    if (/\.md$/i.test(name)) return "markdown";
    return "text";
  }

  #fileIconLabel(name: string): string {
    const type = this.#fileIconClass(name);
    const labels: Record<string, string> = {
      python: "PY",
      javascript: "JS",
      shell: "SH",
      json: "{}",
      html: "HT",
      css: "CS",
      markdown: "MD",
      text: "TX",
    };
    return labels[type] ?? "TX";
  }

  #renderEditor(): void {
    const file = this.#activeFile();
    const editor = this.#element<HTMLTextAreaElement>("code-editor");
    editor.value = file?.content ?? "";
    editor.disabled = !file;
    this.#element<HTMLElement>("active-file-name").textContent = file?.name ?? "ファイルなし";
    this.#element<HTMLElement>("language-label").textContent = file ? this.#languageLabel(file.name) : "プレーンテキスト";
    this.#element<HTMLButtonElement>("run-button").title = file && runtimeForFile(file.name)
      ? "Ctrl+Enter で実行"
      : "実行できるファイルを開いてください";
    this.#renderLineNumbers();
    this.#syncCodeMirror(file?.name ?? "", editor.value);
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    this.#updateRunButtons();
  }

  #syncCodeMirror(name: string, value: string): void {
    if (!this.#codeMirrorView || !this.#languageCompartment) return;

    this.#syncingCodeMirror = true;
    try {
      this.#codeMirrorView.dispatch({
        changes: {
          from: 0,
          to: this.#codeMirrorView.state.doc.length,
          insert: value,
        },
        effects: [this.#languageCompartment.reconfigure(this.#languageExtension(name))],
      });
    } finally {
      this.#syncingCodeMirror = false;
    }
  }

  #languageExtension(name: string): unknown {
    const languages = this.#codeMirrorLanguages;
    if (!languages) return [];

    if (/\.(py|pyw)$/i.test(name)) return languages.python();
    if (/\.(js|mjs|cjs|jsx|ts|tsx)$/i.test(name)) {
      return languages.javascript({ jsx: /\.jsx?$/i.test(name), typescript: /\.tsx?$/i.test(name) });
    }
    if (/\.html?$/i.test(name)) return languages.html();
    if (/\.css$/i.test(name)) return languages.css();
    if (/\.json$/i.test(name)) return languages.json();
    if (/\.md$/i.test(name)) return languages.markdown();
    return [];
  }

  async #initializeCodeMirror(): Promise<void> {
    const urls = [
      "https://esm.sh/codemirror@6.0.1",
      "https://esm.sh/@codemirror/state@6.5.2",
      "https://esm.sh/@codemirror/lang-python@6.2.1",
      "https://esm.sh/@codemirror/lang-javascript@6.2.2",
      "https://esm.sh/@codemirror/lang-html@6.4.9",
      "https://esm.sh/@codemirror/lang-css@6.3.1",
      "https://esm.sh/@codemirror/lang-json@6.0.2",
      "https://esm.sh/@codemirror/lang-markdown@6.3.2",
    ];

    try {
      const modules = await Promise.all(urls.map((url) => import(url)));
      const core = modules[0] as unknown as CodeMirrorCore;
      const state = modules[1] as unknown as CodeMirrorStateModule;

      this.#codeMirrorLanguages = {
        python: (modules[2] as unknown as { python: () => unknown }).python,
        javascript: (modules[3] as unknown as { javascript: CodeMirrorLanguages["javascript"] }).javascript,
        html: (modules[4] as unknown as { html: () => unknown }).html,
        css: (modules[5] as unknown as { css: () => unknown }).css,
        json: (modules[6] as unknown as { json: () => unknown }).json,
        markdown: (modules[7] as unknown as { markdown: () => unknown }).markdown,
      };

      this.#languageCompartment = new state.Compartment();
      const textarea = this.#element<HTMLTextAreaElement>("code-editor");
      const host = this.#element<HTMLElement>("code-editor-cm");
      const language = this.#languageExtension(this.#state.activeFile);

      const extensions = [
        core.basicSetup,
        this.#languageCompartment.of(language),
        core.EditorView.updateListener.of((update) => {
          if (!update.docChanged || this.#syncingCodeMirror) return;

          const file = this.#activeFile();
          if (!file) return;

          file.content = update.state.doc.toString();
          textarea.value = file.content;
          this.#setProjectSaveLabel("未保存", "pending");
          this.#scheduleSave();
        }),
        core.EditorView.theme({
          "&": { height: "100%", fontSize: "12px" },
          ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "21px" },
          ".cm-content": { padding: "15px 18px 28px" },
          ".cm-gutters": { borderRight: "1px solid #edf0f6", background: "#fbfcff", color: "#9aa5b7" },
        }),
      ];

      this.#codeMirrorView = new core.EditorView({
        parent: host,
        state: state.EditorState.create({ doc: textarea.value, extensions }),
      });

      host.hidden = false;
      host.setAttribute("role", "region");
      host.setAttribute("aria-label", "構文ハイライト付きコードエディタ");
      document.getElementById("editor-body")?.classList.add("cm-ready");
      document.getElementById("editor-body")?.setAttribute("data-editor-engine", "codemirror");

      this.#codeMirrorView.dom.addEventListener("keydown", (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void this.saveNow();
        }

        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void this.runSelected();
        }
      });
    } catch (error) {
      document.getElementById("editor-body")?.setAttribute("data-editor-engine", "textarea");
      this.#options.onNotify("構文ハイライトを読み込めなかったため、簡易エディタで続行します。", true);
      console.error(error);
    }
  }

  #languageLabel(name: string): string {
    const labels: Record<string, string> = {
      python3: "Python 3",
      node: "Node.js",
      sh: "Shell",
    };
    return labels[runtimeForFile(name) ?? ""] ?? "プレーンテキスト";
  }

  #renderLineNumbers(): void {
    const editor = this.#element<HTMLTextAreaElement>("code-editor");
    const lineNumbers = this.#element<HTMLElement>("line-numbers");
    const count = Math.max(1, editor.value.split("\n").length);
    lineNumbers.textContent = Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
    lineNumbers.scrollTop = editor.scrollTop;
  }

  #openNewFileForm(): void {
    const form = this.#element<HTMLFormElement>("new-file-form");
    form.hidden = false;
    this.#element<HTMLInputElement>("new-file-name").focus();
    this.#element<HTMLElement>("new-file-error").textContent = "";
  }

  #closeNewFileForm(): void {
    this.#element<HTMLFormElement>("new-file-form").hidden = true;
    this.#element<HTMLInputElement>("new-file-name").value = "";
    this.#element<HTMLElement>("new-file-error").textContent = "";
  }

  #createFile(): void {
    const input = this.#element<HTMLInputElement>("new-file-name");
    const name = input.value.trim();
    const error = validateFileName(name);
    if (error) {
      this.#element<HTMLElement>("new-file-error").textContent = error;
      return;
    }
    if (this.#state.files.some((file) => file.name === name)) {
      this.#element<HTMLElement>("new-file-error").textContent = "同じ名前のファイルがすでにあります。";
      return;
    }
    if (this.#state.files.length >= MAX_FILES) {
      this.#element<HTMLElement>("new-file-error").textContent = `ファイルは${MAX_FILES}個までです。`;
      return;
    }

    this.#state.files.push({ name, content: "" });
    this.#state.activeFile = name;
    this.#closeNewFileForm();
    this.#renderFiles();
    this.#renderEditor();
    this.#scheduleSave();
  }

  async saveNow(): Promise<void> {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    try {
      await this.#persist();
      this.#options.onNotify("プロジェクトを保存しました。");
    } catch (error) {
      this.#options.onNotify(error instanceof Error ? error.message : String(error), true);
    }
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#setProjectSaveLabel("未保存", "pending");
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.#persist().catch((error: unknown) => {
        this.#setProjectSaveLabel("保存エラー", "error");
        this.#options.onNotify(error instanceof Error ? error.message : String(error), true);
      });
    }, 450);
  }

  async #persist(): Promise<void> {
    if (this.#saving) {
      this.#saveAgain = true;
      return;
    }

    this.#saving = true;
    try {
      do {
        this.#saveAgain = false;
        const snapshot = structuredClone(this.#state);
        const problem = validateProjectState(snapshot);
        if (problem) throw new Error(problem);
        await saveProjectState(snapshot);
      } while (this.#saveAgain);
      this.#setProjectSaveLabel("保存済み", "saved");
    } finally {
      this.#saving = false;
    }
  }

  #setProjectSaveLabel(label: string, state: "saved" | "pending" | "error"): void {
    const element = this.#element<HTMLElement>("project-save-label");
    element.textContent = label;
    element.dataset["save"] = state;
  }

  async runSelected(): Promise<void> {
    if (!this.#runEnabled || this.#isRunning) return;
    const file = this.#activeFile();
    if (!file) {
      this.#options.onNotify("実行するファイルを選んでください。");
      return;
    }
    if (!runtimeForFile(file.name)) {
      this.#options.onNotify("実行できるのは .py、.js、.mjs、.cjs、.sh ファイルです。");
      return;
    }

    const problem = validateProjectState(this.#state);
    if (problem) {
      this.#options.onNotify(problem, true);
      return;
    }

    await this.#persist().catch((error: unknown) => {
      this.#options.onNotify(error instanceof Error ? error.message : String(error), true);
    });

    this.#isRunning = true;
    this.#updateRunButtons();
    try {
      await this.#options.onRun(structuredClone(this.#state.files), this.#state.activeFile);
    } catch (error) {
      this.#options.onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.#isRunning = false;
      this.#updateRunButtons();
    }
  }

  #updateRunButtons(): void {
    const run = this.#element<HTMLButtonElement>("run-button");
    const stop = this.#element<HTMLButtonElement>("stop-button");
    run.disabled = !this.#runEnabled || this.#isRunning || !runtimeForFile(this.#state.activeFile);
    run.hidden = this.#isRunning;
    stop.hidden = !this.#isRunning;
    stop.disabled = !this.#isRunning;
  }

  #exportProject(): void {
    const problem = validateProjectState(this.#state);
    if (problem) {
      this.#options.onNotify(problem, true);
      return;
    }

    const blob = new Blob([JSON.stringify({ version: 1, ...this.#state }, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wasmbox-project.json";
    anchor.click();
    URL.revokeObjectURL(url);
    this.#options.onNotify("プロジェクトを書き出しました。");
  }

  async #importProject(file: File): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object") throw new Error("JSONの形式が正しくありません。");
      const input = parsed as { version?: unknown; files?: unknown; activeFile?: unknown };
      if (input.version !== 1 || !Array.isArray(input.files) || typeof input.activeFile !== "string") {
        throw new Error("WasmBox IDEのプロジェクトJSONではありません。");
      }
      const state: ProjectState = {
        files: input.files as ProjectFile[],
        activeFile: input.activeFile,
      };
      const problem = validateProjectState(state);
      if (problem) throw new Error(problem);
      const total = state.files.reduce((sum, entry) => sum + new TextEncoder().encode(entry.content).byteLength, 0);
      if (total > MAX_PROJECT_BYTES || state.files.some((entry) => new TextEncoder().encode(entry.content).byteLength > MAX_FILE_BYTES)) {
        throw new Error("プロジェクトの容量制限を超えています。");
      }
      if (state.files.length > MAX_FILES) throw new Error(`ファイルは${MAX_FILES}個までです。`);

      this.#state = structuredClone(state);
      this.#renderFiles();
      this.#renderEditor();
      this.#scheduleSave();
      this.#options.onNotify("プロジェクトを読み込みました。");
    } catch (error) {
      this.#options.onNotify(error instanceof Error ? error.message : String(error), true);
    }
  }
}
