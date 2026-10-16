// ブラウザでは、v86 と xterm.js を <script> でグローバルに読み込む（vendor/。コミットしない）。
// ここには、WasmBox が使う部分だけの型を書く。

/** libv86.js が定義する V86 */
declare const V86: import("../src/engine/v86-engine.ts").V86Constructor;

interface XtermOptions {
  cols?: number;
  rows?: number;
  fontFamily?: string;
  fontSize?: number;
  cursorBlink?: boolean;
  scrollback?: number;
  theme?: Record<string, string>;
}

interface XtermBufferLine {
  translateToString(trimRight?: boolean): string;
}

/** xterm.js 5.x（@xterm/xterm の lib/xterm.js が定義する Terminal） */
declare class Terminal {
  constructor(options?: XtermOptions);
  readonly cols: number;
  readonly rows: number;
  options: XtermOptions;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(y: number): XtermBufferLine | undefined;
    };
  };
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): { dispose(): void };
  focus(): void;
}
