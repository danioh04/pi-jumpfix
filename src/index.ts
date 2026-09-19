import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

const FULL_RENDER_CLEAR = "\x1b[2J\x1b[H\x1b[3J";
const CLEAR_SCROLLBACK = "\x1b[3J";
const SYNC_END = "\x1b[?2026l";
const KITTY_IMAGE = "\x1b_G";
const ITERM2_IMAGE = "\x1b]1337;File=";
const PATCHED_FLAG = Symbol.for("pi-jumpfix.doRenderPatched");
const FILTERED_FLAG = Symbol.for("pi-jumpfix.terminalFiltered");
const STOCK_KEY = Symbol.for("pi-jumpfix.stockNextFullRender");
const registry = globalThis as typeof globalThis & { [key: symbol]: unknown };

function hasInlineImages(content: string): boolean {
  return content.includes(KITTY_IMAGE) || content.includes(ITERM2_IMAGE);
}

function tailStart(content: string, rows: number): number {
  let index = content.length - 1;
  for (let found = 1; ; found++) {
    if (index < 0) return 0;
    index = content.lastIndexOf("\r\n", index);
    if (index < 0) return 0;
    if (found === rows) return index + 2;
    index -= 1;
  }
}

function assemble(
  prefix: string,
  content: string,
  suffix: string,
  rows: number,
  stock: boolean,
): string {
  if (stock || hasInlineImages(content)) {
    return prefix + FULL_RENDER_CLEAR + content + suffix;
  }
  const start = tailStart(content, rows);
  const tail =
    start > 0 ? content.slice(start).replaceAll(CLEAR_SCROLLBACK, "") : content;
  const body = tail
    .split("\r\n")
    .map((line) => `\x1b[2K${line}`)
    .join("\r\n");
  return `${prefix}\x1b[H${body}\x1b[J${suffix}`;
}

function installPatch(TuiClass: unknown): void {
  const prototype = (TuiClass as { prototype: Record<PropertyKey, unknown> })
    .prototype;
  if (prototype[PATCHED_FLAG]) return;
  const original = prototype["doRender"] as (
    this: unknown,
    ...args: unknown[]
  ) => unknown;
  prototype[PATCHED_FLAG] = true;
  prototype["doRender"] = function patchedDoRender(
    this: { terminal?: unknown },
    ...args: unknown[]
  ): void {
    ensureTerminalFilter(this.terminal);
    original.apply(this, args);
  };
}

function ensureTerminalFilter(terminal: unknown): void {
  const term = terminal as {
    [key: symbol]: unknown;
    write?: (...args: unknown[]) => unknown;
    rows?: unknown;
    columns?: unknown;
  };
  if (term[FILTERED_FLAG]) return;
  const originalWrite = term.write as (...args: unknown[]) => unknown;
  term[FILTERED_FLAG] = true;
  let lastColumns = term.columns as number;
  let lastRows = term.rows as number;
  let pending: { prefix: string; content: string; stock: boolean } | null =
    null;
  term.write = function filteredWrite(this: unknown, ...args: unknown[]): void {
    const [buffer, ...rest] = args;
    const data = buffer as string;
    const rows = term.rows as number;
    const resized = term.columns !== lastColumns || rows !== lastRows;
    lastColumns = term.columns as number;
    lastRows = rows;
    if (pending) {
      const end = data.lastIndexOf(SYNC_END);
      if (end === -1) {
        pending.content += data;
        return;
      }
      const content = pending.content + data.slice(0, end);
      const output = assemble(
        pending.prefix,
        content,
        data.slice(end),
        rows,
        pending.stock,
      );
      pending = null;
      originalWrite.apply(this, [output, ...rest]);
      return;
    }
    const clearIndex = data.indexOf(FULL_RENDER_CLEAR);
    if (clearIndex === -1) {
      originalWrite.apply(this, args);
      return;
    }
    let stock = resized;
    if (registry[STOCK_KEY] === true) {
      stock = true;
      registry[STOCK_KEY] = false;
    }
    const contentStart = clearIndex + FULL_RENDER_CLEAR.length;
    const syncEnd = data.lastIndexOf(SYNC_END);
    if (syncEnd === -1) {
      pending = {
        prefix: data.slice(0, clearIndex),
        content: data.slice(contentStart),
        stock,
      };
      return;
    }
    const output = assemble(
      data.slice(0, clearIndex),
      data.slice(contentStart, syncEnd),
      data.slice(syncEnd),
      rows,
      stock,
    );
    originalWrite.apply(this, [output, ...rest]);
  };
}

export default function jumpfix(pi: ExtensionAPI): void {
  installPatch(piTui.TuiMainScreen);
  pi.on("session_start", (event) => {
    if (
      event.reason === "new" ||
      event.reason === "resume" ||
      event.reason === "fork"
    ) {
      registry[STOCK_KEY] = true;
    }
  });
}
