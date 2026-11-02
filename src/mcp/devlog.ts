/**
 * graft-Max developer log: timestamped, human-readable trace of everything
 * this MCP server does — every JSON-RPC method in, every tool call with its
 * arguments and the answer it produced, plus federation child-process
 * lifecycles. Off by default; on when GRAFT_MAX_LOG=1 (or a path, to redirect
 * from the default ~/.graft-max/mcp.log).
 *
 * The file, not stderr: a host captures the server's stderr into its own log
 * (or drops it), and interleaving ours with theirs makes both unreadable. A
 * dedicated append-only file is greppable, tailable (`Get-Content -Wait`) and
 * survives the host's log rotation.
 *
 * Writes are fire-and-forget appends — a logging failure must never take the
 * server down, and blocking a tool call on I/O would betray the timeout
 * discipline in federation.ts.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_LOG = join(homedir(), '.graft-max', 'mcp.log');

let enabled = !!process.env.GRAFT_MAX_LOG && process.env.GRAFT_MAX_LOG !== '0';
let target = process.env.GRAFT_MAX_LOG && process.env.GRAFT_MAX_LOG !== '1' ? process.env.GRAFT_MAX_LOG : DEFAULT_LOG;
let ensured = false;

/** Timestamp the way a developer reads it: local time, ms precision. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Truncate a payload for the log: full enough to debug from, bounded so a
 * giant tool answer doesn't turn the log itself into a context bomb. */
export function clip(s: string, max = 2000): string {
  const one = s.replaceAll('\r', '');
  return one.length <= max ? one : `${one.slice(0, max)}\n… [+${one.length - max} chars]`;
}

async function write(line: string): Promise<void> {
  try {
    if (!ensured) {
      ensured = true;
      await mkdir(dirname(target), { recursive: true });
    }
    await appendFile(target, line + '\n', 'utf8');
  } catch {
    /* logging never takes the server down */
  }
}

export function isLogEnabled(): boolean {
  return enabled;
}

export function logPath(): string {
  return target;
}

/** One log line. Safe to call always: no-op when logging is off. */
export function dlog(msg: string): void {
  if (!enabled) return;
  void write(`[${stamp()}] ${msg}`);
}

/** Log a structured block (tool call / answer). */
export function dlogBlock(title: string, body: string): void {
  if (!enabled) return;
  void write(`[${stamp()}] ${title}\n${clip(body)}\n`);
}
