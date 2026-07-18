// AgentSession: a thin wrapper over bun-pty that runs a single command in a
// real PTY, accumulating its raw byte stream and forwarding chunks as they
// arrive. Used by the engine in place of a headless Bun.spawn so agent CLIs
// see a TTY (colors, progress bars, etc. all work) and their output can be
// rendered faithfully by ghostty-opentui.

import { spawn, type IPty } from "bun-pty";

export interface SessionOptions {
  cmd: string[];
  env?: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
  onData: (chunk: string) => void;
}

function clampSize(n: number): number {
  return Math.max(2, Math.floor(n));
}

export class AgentSession {
  private readonly pty: IPty;
  private _raw = "";
  private _exited = false;
  private _killing = false;

  /** Resolves with the process exit code once the PTY session ends. */
  readonly exited: Promise<number>;

  constructor(opts: SessionOptions) {
    const [file, ...args] = opts.cmd;
    if (!file) {
      throw new Error("AgentSession requires a non-empty cmd");
    }

    this.pty = spawn(file, args, {
      name: "xterm-256color",
      cols: clampSize(opts.cols),
      rows: clampSize(opts.rows),
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });

    const dataDisposable = this.pty.onData((chunk) => {
      this._raw += chunk;
      opts.onData(chunk);
    });

    this.exited = new Promise<number>((resolve) => {
      const exitDisposable = this.pty.onExit((e) => {
        this._exited = true;
        dataDisposable.dispose();
        exitDisposable.dispose();
        resolve(e.exitCode);
      });
    });
  }

  /** All bytes received from the PTY so far (raw, including ANSI escapes). */
  get raw(): string {
    return this._raw;
  }

  /** Resize the underlying PTY. No-op once the process has exited. */
  resize(cols: number, rows: number): void {
    if (this._exited) return;
    try {
      this.pty.resize(clampSize(cols), clampSize(rows));
    } catch {
      // The PTY may have exited concurrently; nothing to do.
    }
  }

  /** Write raw input to the PTY. No-op once exited. */
  write(data: string): void {
    if (this._exited) return;
    try {
      this.pty.write(data);
    } catch {
      // The PTY may have exited concurrently; nothing to do.
    }
  }

  /** Idempotent: SIGTERM immediately, SIGKILL after 3s if still alive. */
  kill(): void {
    if (this._exited || this._killing) return;
    this._killing = true;
    try {
      this.pty.kill("SIGTERM");
    } catch {
      // Already dead.
    }
    setTimeout(() => {
      if (!this._exited) {
        try {
          this.pty.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }
    }, 3000);
  }
}
