/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

/**
 * Pane ids in the session that contains `anchor` (default: the parent pi pane).
 * Scoped to one session on purpose: psmux numbers panes per session, so `%1`
 * exists in every session and `list-panes -a` cannot identify a pane.
 * Returns null when tmux cannot answer.
 */
function listSessionPaneIds(anchor?: string): Set<string> | null {
  const target = anchor ?? process.env.TMUX_PANE;
  try {
    const args = ["list-panes", "-s", ...(target ? ["-t", target] : []), "-F", "#{pane_id}"];
    const out = execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith("%")));
  } catch {
    return null;
  }
}

/**
 * False only when tmux positively reports the pane is gone from the parent's
 * session. Any uncertainty (tmux not answering) counts as alive, so a hiccup
 * can never end a running subagent.
 */
export function surfaceExists(surface: string): boolean {
  const ids = listSessionPaneIds();
  return ids === null || ids.has(surface);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  // psmux (Windows tmux) does not fail when there is no room to split: it exits 0
  // and prints an EXISTING pane id (the target). Using that id would type the
  // subagent command into, and later kill, the parent pi pane. Only accept a
  // pane id that did not exist before the split.
  const before = listSessionPaneIds(fromSurface) ?? new Set<string>();
  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }
  if (before.has(pane) || pane === fromSurface) {
    throw new Error(
      `tmux could not create a new pane (no space left to split; got existing pane ${pane}). ` +
        "Close some subagent panes or enlarge the terminal window.",
    );
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, bashLaunchCommand(surface, scriptPath));
  return scriptPath;
}

// ── Windows: run launcher scripts with Git Bash ──
//
// On Windows the pane shell is usually PowerShell, where a bare `bash` resolves to
// C:\Windows\System32\bash.exe (WSL). WSL bash strips the backslashes from the
// Windows script path ("C:UsersFreddy...sh: No such file"), the subagent never
// starts and its pane is left open. So resolve Git Bash explicitly.

let cachedWindowsBash: string | null | undefined;

function isWslBash(p: string): boolean {
  return /[\\/](system32|windowsapps)[\\/]bash\.exe$/i.test(p);
}

/** Locate Git Bash (not WSL) on Windows. Override with PI_SUBAGENT_BASH. */
export function findWindowsBash(): string | null {
  if (cachedWindowsBash !== undefined) return cachedWindowsBash;
  const candidates: string[] = [];
  if (process.env.PI_SUBAGENT_BASH) candidates.push(process.env.PI_SUBAGENT_BASH);
  // Pi's own shellPath setting is the bash the user already runs Pi's tools with.
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    if (typeof settings.shellPath === "string") candidates.push(settings.shellPath);
  } catch {}
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
    if (base) candidates.push(join(base, "Git", "bin", "bash.exe"));
  }
  candidates.push(join(homedir(), "scoop", "apps", "git", "current", "bin", "bash.exe"));
  try {
    // <git>\cmd\git.exe -> <git>\bin\bash.exe
    const git = execFileSync("where.exe", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
    if (git) candidates.push(join(dirname(dirname(git)), "bin", "bash.exe"));
  } catch {}
  cachedWindowsBash = null;
  for (const raw of candidates) {
    const p = raw.replace(/[\\/]+/g, "/");
    if (!isWslBash(p) && existsSync(p)) {
      cachedWindowsBash = p;
      break;
    }
  }
  return cachedWindowsBash;
}

/** The command typed into a pane to run a launcher script, in that pane shell's syntax. */
export function bashLaunchCommand(surface: string, scriptPath: string): string {
  if (process.platform !== "win32") return `bash ${shellEscape(scriptPath)}`;
  const bash = findWindowsBash();
  if (!bash) {
    throw new Error(
      "Git Bash not found (plain `bash` on Windows is WSL, which cannot run the subagent launcher). " +
        "Install Git for Windows or set PI_SUBAGENT_BASH to Git's bin\\bash.exe.",
    );
  }
  const script = scriptPath.replace(/\\/g, "/");
  let shell = "";
  try {
    shell = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{pane_current_command}"], {
      encoding: "utf8",
    }).trim().toLowerCase();
  } catch {}
  const name = shell.replace(/\.exe$/, "");
  if (name === "cmd") return `"${bash}" "${script}"`;
  if (["bash", "sh", "zsh", "dash", "fish"].includes(name)) {
    return `${shellEscape(bash)} ${shellEscape(script)}`;
  }
  // PowerShell (psmux's default) and unknown shells: call operator + single quotes.
  return `& ${shellEscape(bash)} ${shellEscape(script)}`;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  // A pane that is already gone (closed by the user or the orchestrator) is fine.
  if (!surfaceExists(surface)) return;
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** True when the pane disappeared before the subagent signalled completion. */
  paneClosed?: boolean;
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  // Consecutive polls that found the pane missing; two in a row avoids acting
  // on a single transient tmux failure.
  let missingPolls = 0;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    // Pane killed (by the user, the orchestrator, or a crash) before the
    // subagent printed its done sentinel: nothing will ever arrive, so end the
    // watch instead of polling forever and leaving a ghost in the widget.
    if (!surfaceExists(surface)) {
      missingPolls++;
      if (missingPolls >= 2) {
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent pane was closed before the subagent finished.",
          paneClosed: true,
        };
      }
    } else {
      missingPolls = 0;
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
