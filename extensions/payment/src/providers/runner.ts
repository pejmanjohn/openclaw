import { execFile } from "node:child_process";

export type CommandRunResult = {
  stdout: string;
  stderr: string;
  /** Real exit code, or -1 if the process was killed by a signal. */
  exitCode: number;
  /** Set when the process was terminated by a signal (SIGTERM, SIGKILL, etc.). */
  signal?: NodeJS.Signals;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Stdin payload, if any. */
    input?: string;
  },
) => Promise<CommandRunResult>;

/**
 * Production runner for the Stripe Link adapter. Calls execFile("link-cli", [...]) with the
 * executable name as a string literal so ClawHub's isSafeLiteralExecFileCall carve-out
 * auto-clears the suspicious.dangerous_exec static-analysis finding.
 *
 * The `command` argument from the CommandRunner signature is intentionally ignored —
 * the literal "link-cli" is required by the carve-out pattern.
 *
 * Tests inject their own runner via the `runner` option on createStripeLinkAdapter.
 */
export function createLinkCliCommandRunner(): CommandRunner {
  return function runCommand(
    _command: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      input?: string;
    },
  ): Promise<CommandRunResult> {
    return new Promise((resolve, reject) => {
      // Literal first arg required for ClawHub isSafeLiteralExecFileCall carve-out.
      const child = execFile("link-cli", [...args], {
        cwd: options?.cwd,
        env: options?.env ?? process.env,
      });

      // Silence EPIPE / ERR_STREAM_DESTROYED that can fire when the child exits
      // before reading stdin, or before stdout/stderr are fully drained.
      // These listeners MUST be registered before any stdin.write() / stdin.end() call.
      child.stdin?.on("error", () => {
        /* swallow EPIPE / ERR_STREAM_DESTROYED on early kill */
      });
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});

      // execFile (unlike spawn) may emit string chunks instead of Buffers when no
      // callback is passed — Node normalises the stream encoding internally. Collect
      // as (Buffer | string)[] and convert at resolve-time.
      const stdoutChunks: (Buffer | string)[] = [];
      const stderrChunks: (Buffer | string)[] = [];

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(chunk);
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate to SIGKILL after 2 seconds if the child didn't exit on SIGTERM.
          sigkillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already exited */
            }
          }, 2000);
        }, options.timeoutMs);
      }

      child.on("error", (err: Error) => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        if (sigkillTimer !== undefined) {
          clearTimeout(sigkillTimer);
        }
        reject(new Error(`Command "link-cli" failed to spawn: ${err.message}`));
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        if (sigkillTimer !== undefined) {
          clearTimeout(sigkillTimer);
        }
        if (timedOut) {
          reject(
            new Error(
              `Command "link-cli" timed out after ${options?.timeoutMs ?? 0}ms and was killed with SIGTERM`,
            ),
          );
          return;
        }
        const toUtf8 = (chunks: (Buffer | string)[]): string =>
          chunks.map((c) => (Buffer.isBuffer(c) ? c.toString("utf8") : c)).join("");
        resolve({
          stdout: toUtf8(stdoutChunks),
          stderr: toUtf8(stderrChunks),
          exitCode: code ?? -1,
          signal: signal ?? undefined,
        });
      });

      // Write stdin if provided
      if (options?.input !== undefined) {
        child.stdin?.write(options.input, "utf8", () => {
          child.stdin?.end();
        });
      } else {
        child.stdin?.end();
      }
    });
  };
}
