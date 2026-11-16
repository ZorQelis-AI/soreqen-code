/**
 * A pseudo-terminal, for commands that ask questions.
 *
 * ## Why a pipe is not enough
 *
 * Every command used to run with stdin closed. A program that asks something
 * — `npm create vite` for a project name, `prisma migrate dev` for a
 * migration name, anything that says "Proceed? (y/N)" — read end-of-file and
 * failed. Opening a pipe instead would not fix most of them: the prompt
 * libraries modern CLIs use check that they are attached to a terminal and
 * refuse otherwise. A pseudo-terminal is a terminal, so they ask, and the
 * agent can answer.
 *
 * ## Optional, on purpose
 *
 * `node-pty` is a native module. It ships prebuilt for Windows and macOS; on a
 * platform where it cannot load, `loadPty` returns null and commands run on
 * pipes exactly as before — interactive mode is refused with a reason rather
 * than the whole runner failing to start.
 */

import { createRequire } from "node:module";

export interface Pty {
  pid: number;
  write(data: string): void;
  /** The terminal's size, in characters: the embedded terminal follows its panel. */
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string | undefined> },
  ): Pty;
}

let loaded: PtyModule | null | undefined;

/** The module, or null when this platform cannot load it. Loaded once, on first use. */
export function loadPty(): PtyModule | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = createRequire(import.meta.url)("node-pty") as PtyModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

/**
 * Terminal output as text.
 *
 * A terminal program writes colour codes, cursor movement and window-title
 * sequences, which are noise to a model and to a log view. `\r\n` becomes
 * `\n`, like the pipe output everything else in the product is built on.
 */
export function stripTerminalCodes(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n");
}

/** An escape sequence that has begun but not yet ended, at the very end of a chunk. */
const UNFINISHED = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?)?$|\r$/;

/**
 * `stripTerminalCodes` for a stream that arrives in pieces.
 *
 * A pipe splits output wherever its buffer fills, so a colour code can be
 * cut in half — `\x1b[3` at the end of one chunk, `2m` at the start of the
 * next. Stripping each chunk alone leaves both halves in the text, and the
 * words around them no longer read as one string. Whatever might be the start
 * of a sequence is held back and prefixed to the next chunk.
 */
export function createTerminalStripper(): { push(chunk: string): string; end(): string } {
  let carry = "";
  return {
    push(chunk: string): string {
      const text = carry + chunk;
      const held = UNFINISHED.exec(text);
      carry = held && held[0] ? held[0] : "";
      return stripTerminalCodes(carry ? text.slice(0, text.length - carry.length) : text);
    },
    end(): string {
      const rest = stripTerminalCodes(carry.replace(/\x1b[^]*$/, ""));
      carry = "";
      return rest;
    },
  };
}
