import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = process.env.E2E_ROOT ?? REPO_ROOT;
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');
import { get } from 'node:http';
const c = spawn(process.execPath, [CLI, 'mcp', REPO], { env: { ...process.env, GRAFT_MAX_LOG: '1', GRAFT_MAX_UI: '24688' }, windowsHide: true });
c.stderr.on('data', d => { const s = d.toString(); if (s.includes('dashboard')) console.log('DASH-BOOT:', s.trim()); });
c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
setTimeout(() => {
  get('http://127.0.0.1:24688/sessions', res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { console.log('SESSIONS:', b.slice(0, 300)); c.kill(); process.exit(0); }); }).on('error', e => { console.log('ERR', e.message); c.kill(); process.exit(1); });
}, 4000);
