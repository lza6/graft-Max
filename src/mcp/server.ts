/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { hasGraftIndex } from '../graph/root.js';
import { mainWorktreeRoot } from '../graph/seed.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { maybeFlushInBackground, track } from '../telemetry/index.js';
import { brand, inBrand } from '../brand.js';
import { canonicalToolName, GRAFT_MCP_TOOL_NAMES } from './tool-names.js';
import { WorkspaceConnector, type RemotePrompt, type RemoteTool } from './connector.js';
import { teamLine, teamWorkspace } from '../cloud/team-file.js';
import { KeptListing, within } from './kept-listing.js';
// [graft-Max] sibling-tool federation: qmd/gitnexus proxied through this server.
import { availableFederatedTools, callFederatedTool, FEDERATED_TOOL_NAMES } from './federation.js';
// [graft-Max] developer log (GRAFT_MAX_LOG=1 or a path; default ~/.graft-max/mcp.log)
import { dlog, dlogBlock, clip, logPath, registerSession, endSession, bumpRequests } from './devlog.js';
import { startDashboard } from './dashboard.js';
// [graft-Max] 全局提示词注入（GRAFT_MAX_MCP=1 时生效，切回原版即摘除）
import { upsertGlobalPrompt, removeGlobalPrompt } from '../hosts/max-prompt.js';

/**
 * MCP tool name → the command enum the telemetry contract knows. A tool absent
 * here is simply not counted: `track` would drop an unlisted command anyway, and
 * mapping by hand keeps the wire vocabulary identical across the CLI and MCP so
 * `ask` means the same thing in both.
 */
const TOOL_COMMAND: Record<string, string> = {
  graft_find_code: 'ask',
  graft_find_all: 'grep',
  graft_trace_calls: 'callers',
  graft_file_api: 'skeleton',
  graft_repo_map: 'map',
  graft_check_freshness: 'check',
};

/**
 * How long the client waits on the workspace, counted once from boot: for
 * `initialize`'s instructions and the first `tools/list` and `prompts/list`.
 * After that they answer at once with what they have (kept-listing.ts): a
 * slow cloud never holds the repo tools up for long.
 */
const WORKSPACE_WAIT_MS = 4000;

/** What the workspace-only server says when this machine isn't paired (any more). */
const NOT_CONNECTED_LINE = "This laptop isn't signed in to Trail, so your workspace's learnings and skills aren't here. Run `trail login` and give the user the link it prints: one click in their browser signs this laptop in.";


/** Said when paired but the workspace said no: a refused token, or a Trail without this connector. */
const REFUSED_LINE =
  "Your Trail workspace refused this laptop's sign-in, or is an older version without this connector, so its learnings and skills aren't here. Run `trail logout`, then `trail login`, and give the user the link it prints.";

/** Said when paired but the workspace didn't answer in time. */
const UNREACHABLE_LINE = "Your Trail workspace didn't answer when this session started, so its learnings and skills may be missing here.";

/** Whether a tool name is one of the repo's own (graft_*, trail_* and their old names). */
function isRepoTool(name: string): boolean {
  return GRAFT_MCP_TOOL_NAMES.has(name.toLowerCase()) || GRAFT_MCP_TOOL_NAMES.has(canonicalToolName(name).toLowerCase());
}

function send(msg: object): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: unknown, result: object): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Which tools this server admits to having.
 *
 * `hosts/claude-global.ts` registers graft at the *user* MCP scope, which starts this
 * server in every project the user opens — including ones that never asked for graft.
 * Six tool schemas is real context, charged on every turn of every session, and in a
 * repo with no graph every one of them can only answer "run graft build". So a repo
 * that never invited graft is told there is nothing to call.
 *
 * The parent-checkout clause is not an optimization, it is the case the global
 * registration exists for: a fresh `git worktree add` has no `graft/` of its own
 * (it's gitignored, so git never checks it out) and gets one from its parent on the
 * first query — see graph/seed.ts. Gating on this tree alone would hide graft in
 * precisely the worktree the user is trying to work in, which is the bug, inverted.
 *
 * A `--dir` override is an explicit "the graph is over there", so it always
 * advertises without a probe.
 */
function advertised(root: string, dirOverride?: string): typeof TOOLS {
  if (dirOverride !== undefined) return TOOLS;
  if (hasGraftIndex(root)) return TOOLS;
  const main = mainWorktreeRoot(root);
  return main && hasGraftIndex(main) ? TOOLS : [];
}

/**
 * `version` is threaded in from the CLI rather than read here: `readCurrentVersion`
 * resolves package.json relative to the calling module, and from `dist/mcp/` that
 * lookup misses. The caller already knows it.
 */
export function startMcpServer(root: string, dirOverride?: string, version = '0', opts: { brainsOnly?: boolean } = {}): void {
  // `trail mcp --brains`: the one entry Claude Code gets once paired with a
  // workspace. It serves the workspace's tools and prompts and nothing of the
  // repo's, so it does none of the repo upkeep either: it starts in every
  // project. (The flag keeps its old name: entries already written use it.)
  const brainsOnly = opts.brainsOnly === true;
  // The self-maintenance pass, run once at boot. This is the ONLY channel that
  // reaches hosts with no hook support (Cursor, and any plain MCP client): it
  // refreshes rule files an older `graft init` wrote, and kicks off the cached
  // registry check. Both are fail-soft, and the resulting lines ride along in
  // `instructions` below — stdout is protocol-only, so there is nowhere else to
  // put them. Never blocks: the registry fetch happens in a detached child.
  const upkeep = brainsOnly ? [] : runUpkeep(root, runningVersion()).lines;
  // [graft-Max] developer log: boot line with everything a debugging session needs.
  dlog(`=== graft-Max MCP server boot === root=${root} brainsOnly=${brainsOnly} version=${version} pid=${process.pid} federated=on log=${logPath()}`);
  registerSession(root, version);
  // 自动注入/摘除全局提示词：Max 开着就在，切原版自动摘（配合 switch-mcp.py）
  if (process.env.GRAFT_MAX_MCP === '1') {
    const act = upsertGlobalPrompt();
    dlog(`全局提示词${act === 'created' ? '已注入' : act === 'updated' ? '已更新' : '无变化'}: ${act}`);
  } else {
    if (removeGlobalPrompt()) dlog('全局提示词已摘除（GRAFT_MAX_MCP 未启用）');
  }
  startDashboard();
  for (const line of upkeep) console.error(line);
  // Same deal for the telemetry queue: flushed from a detached child at boot, so
  // a Cursor user who never touches the CLI still gets their events out.
  //
  // Deliberately NOT the first-run notice. This server's stderr goes to an editor
  // log nobody reads, so printing it here would mark the disclosure as shown
  // without anyone having seen it. It stays pending for the next CLI command,
  // and `graft init`'s picker is the channel that reached this user already.
  if (!brainsOnly) maybeFlushInBackground();

  // The workspace's own MCP server, when this machine is paired with one:
  // started now, so its instructions are in hand by the time the client asks.
  const workspace = new WorkspaceConnector({ version, cwd: root });
  // One wait for the workspace, from boot: initialize and the first lists share it, and once it has
  // passed they answer at once with what they have, and `list_changed` brings the rest.
  const deadline = Date.now() + WORKSPACE_WAIT_MS;
  const changed = (method: string) => () => send({ jsonrpc: '2.0', method });
  const tools = new KeptListing<RemoteTool>(() => workspace.listTools(), changed('notifications/tools/list_changed'));
  const prompts = new KeptListing<RemotePrompt>(() => workspace.listPrompts(), changed('notifications/prompts/list_changed'));
  if (workspace.connected()) {
    workspace.warm();
    void tools.refresh();
    void prompts.refresh();
  }

  /** The repo's tools this server lists, under trail as `trail_*` in trail's words.
   * [graft-Max] plus the federated sibling tools (max_find_docs / max_trace_arch),
   * probed once at first tools/list — an uninstalled backend hides its tool.
   * Federation follows the repo's advertise decision (`advertised()`): a repo
   * that never invited graft gets neither the graft six nor the max_* two —
   * same context-budget reasoning, just more tools. */
  const federated = new KeptListing<Awaited<ReturnType<typeof availableFederatedTools>>[number]>(
    () => availableFederatedTools(),
    changed('notifications/tools/list_changed'),
  );
  if (!brainsOnly && (dirOverride !== undefined || hasGraftIndex(root) || !!mainWorktreeRoot(root))) void federated.refresh();

  const repoTools = () =>
    (brainsOnly ? [] : advertised(root, dirOverride)).map((t) => ({ name: inBrand(t.name), description: inBrand(t.description), inputSchema: t.inputSchema }));
  /** Federated tools, gated on the same advertise decision as the graft tools. */
  const federatedTools = (): Promise<Awaited<ReturnType<typeof availableFederatedTools>>> =>
    brainsOnly || advertised(root, dirOverride).length === 0 ? Promise.resolve([]) : federated.get(deadline);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, any> };
    try {
      msg = JSON.parse(text);
    } catch {
      replyError(null, -32700, 'parse error');
      return;
    }
    const { id, method, params } = msg;
    const isNotification = id === undefined;
    // [graft-Max] log every inbound request (args clipped to keep the log usable)
    if (method === 'tools/call') {
      dlogBlock(`--> tools/call  id=${String(id)}  name=${String(params?.name ?? '')}`, JSON.stringify(params?.arguments ?? {}, null, 1));
      bumpRequests();
    } else dlog(`<-- ${method}  id=${String(id)}${isNotification ? ' (notification)' : ''}`);
    const paired = workspace.connected();
    switch (method) {
      case 'initialize': {
        const local = [upkeep.length ? upkeep.join('\n') : '', brainsOnly ? '' : mcpInstructions()];
        const answer = (remote: string[]) =>
          reply(id, {
            protocolVersion: params?.protocolVersion ?? '2024-11-05',
            // Paired: the workspace's prompts too, and lists that can change once it answers.
            capabilities: paired ? { tools: { listChanged: true }, prompts: { listChanged: true } } : { tools: {} },
            serverInfo: { name: brand(), version },
            // The one channel that survives tool deferral — see ./instructions.ts.
            // The workspace's own instructions follow the repo's.
            instructions: [...local, ...remote].filter(Boolean).join('\n\n'),
          });
        if (!paired) {
          const team = brainsOnly ? null : teamWorkspace(root);
          answer([brainsOnly ? NOT_CONNECTED_LINE : team ? teamLine(team.name, team.workspace) : '']);
          return;
        }
        within(workspace.instructions(), deadline - Date.now(), '').then(({ value }) =>
          answer([value || (workspace.started() ? '' : workspace.refusal() ? REFUSED_LINE : UNREACHABLE_LINE)]),
        );
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications get no response
      case 'ping':
        if (!isNotification) reply(id, {});
        return;
      case 'tools/list': {
        if (isNotification) return;
        const local = repoTools();
        if (!paired) {
          // [graft-Max] federated sibling tools ride along, but ONLY when the
          // repo invited graft (advertised() non-empty) — same budget rule.
          federatedTools().then(
            (f) => {
              dlog(`<-- tools/list  id=${String(id)}  ->  ${[...local, ...(f ?? [])].map((t) => t.name).join(', ')}`);
              reply(id, { tools: [...local, ...(f ?? [])] });
            },
            () => reply(id, { tools: local }),
          );
          return;
        }
        // Paired: the workspace's tools too, as it defines them. A repo tool's name wins a clash.
        const taken = new Set(local.map((t) => t.name));
        federatedTools().then(
          (f) =>
            tools.get(deadline).then((remote) => {
              const fed = (f ?? []).filter((t) => !taken.has(t.name));
              reply(id, { tools: [...local, ...fed, ...remote.filter((t) => !taken.has(t.name))] });
            }),
          () => tools.get(deadline).then((remote) => reply(id, { tools: [...local, ...remote.filter((t) => !taken.has(t.name))] })),
        );
        return;
      }
      case 'prompts/list': {
        if (isNotification) return;
        if (!paired) {
          reply(id, { prompts: [] });
          return;
        }
        prompts.get(deadline).then((list) => reply(id, { prompts: list }));
        return;
      }
      case 'prompts/get': {
        if (isNotification) return;
        // Every prompt is the workspace's: the repo serves none. Never throws.
        workspace.getPrompt(String(params?.name ?? ''), (params?.arguments ?? {}) as Record<string, unknown>).then((r) =>
          'result' in r ? reply(id, (r.result ?? {}) as object) : replyError(id, r.error.code, r.error.message),
        );
        return;
      }
      case 'tools/call': {
        if (isNotification) return;
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (!isRepoTool(name) && (paired || brainsOnly)) {
          // The workspace's: passed to it as is. Never throws.
          workspace.callTool(name, args).then((r) => reply(id, r));
          return;
        }
        if (brainsOnly) {
          reply(id, { content: [{ type: 'text', text: `this server answers your Trail workspace's tools only; ${name} isn't one` }], isError: true });
          return;
        }
        // [graft-Max] federated sibling tools (max_*) — proxied before the repo
        // graph path. Never throws; every failure comes back as isError content.
        if (FEDERATED_TOOL_NAMES.has(name.toLowerCase())) {
          const t0 = Date.now();
          callFederatedTool(name, args, root).then(
            (r) => {
              dlogBlock(`<-- tools/call (federated)  ${name}  ${Date.now() - t0}ms  isError=${r?.isError}`, r?.text ?? 'unknown tool');
              reply(id, r ? { content: [{ type: 'text', text: r.text }], isError: r.isError } : { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true });
            },
            (err) => {
              dlog(`<-- tools/call (federated)  ${name}  ${Date.now() - t0}ms  REJECTED: ${err instanceof Error ? err.message : String(err)}`);
              replyError(id, -32603, err instanceof Error ? err.message : String(err));
            },
          );
          return;
        }
        // Async because a tool call may rebuild the graph first (see
        // graph/refresh.ts). `callTool` absorbs its own errors, so the only thing
        // that can reject here is a bug — surface it as a JSON-RPC error rather
        // than an unhandled rejection that kills the server.
        const graftCallT0 = Date.now();
        callTool(root, name, args, dirOverride).then(
          (r) => {
            dlogBlock(`<-- tools/call (graft)  ${name}  ${Date.now() - graftCallT0}ms  isError=${r.isError}`, r.text);
            // No `hit`: `isError` means the tool failed, which is not the same
            // question as "did the graph have an answer". Absent beats wrong.
            // hasOwn for the same reason as track()'s: a client is free to send
            // `{"name":"constructor"}`, and a plain lookup would hand `track` a
            // function rather than undefined.
            const canonical = canonicalToolName(name);
            const command = Object.hasOwn(TOOL_COMMAND, canonical) ? TOOL_COMMAND[canonical] : undefined;
            track('query', { command, surface: 'mcp' }, { repo: root, host: 'mcp' });
            reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
          },
          (err) => {
            dlog(`<-- tools/call (graft)  ${name}  REJECTED: ${err instanceof Error ? err.message : String(err)}`);
            replyError(id, -32603, err instanceof Error ? err.message : String(err));
          },
        );
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
    }
  });
  process.stdin.on('end', () => {
    dlog(`=== graft-Max MCP server exit === pid=${process.pid}`);
    endSession();
    process.exit(0);
  });
  // [graft-Max] stdin-leash: on Windows a host crash can leave our stdin open
  // forever (the 'end' event never fires), leaking the process AND its
  // dashboard port. The leash exits when stdin has delivered nothing for 10
  // minutes — an MCP host always writes within that window in a live session
  // (tool calls, pings), and a dead one never does. Re-armed by every stdin
  // byte via the readline 'line' handler above.
  let lastStdin = Date.now();
  rl.on('line', () => {
    lastStdin = Date.now();
  });
  const leash = setInterval(() => {
    if (Date.now() - lastStdin > 10 * 60_000) {
      dlog(`=== graft-Max MCP server exit (stdin leash: silent 10min) === pid=${process.pid}`);
      endSession();
      process.exit(0);
    }
  }, 60_000);
  leash.unref();
}
