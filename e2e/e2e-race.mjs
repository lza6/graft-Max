import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = process.env.E2E_ROOT ?? REPO_ROOT;
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
const ENV = { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_MCP: '1' };
const servers = [];
for (let i = 0; i < 5; i++) {
  const c = spawn(process.execPath, [CLI, 'mcp', REPO], { env: ENV, windowsHide: true });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'r'+i, version: '0' } } }) + '\n');
  for (let j = 0; j < 10; j++) {
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10+j, method: 'tools/call', params: { name: 'max_check_freshness', arguments: {} } }) + '\n');
  }
  servers.push(c);
}
await new Promise(r => setTimeout(r, 8000));
const p = join(homedir(), '.graft-max', 'sessions.json');
const raw = readFileSync(p, 'utf8');
try {
  const rows = JSON.parse(raw || '[]');
  const mine = rows.filter(r => r.requests > 0);
  console.log('PASS sessions.json 合法 JSON，', rows.length, '行，', mine.length, '个有请求数');
  servers.forEach(s => s.kill());
  process.exit(0);
} catch(e) {
  console.log('FAIL sessions.json 损坏:', e.message, '| raw len:', raw.length);
  servers.forEach(s => s.kill());
  process.exit(1);
}
