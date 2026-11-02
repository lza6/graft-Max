#!/usr/bin/env python3
"""graft-Max 一键切换: python switch-mcp.py max|orig|status

安全设计（.claude.json 是 Claude Code 主进程的活文件，绝不能整写）：
- 读入内存改 graft 条目，写回时"字节级精准替换"——只动 mcpServers.graft，
  其余字节原样保留（文件含大小写重复键，任何 JSON 重序列化都会破坏它，
  实测曾把 246KB 配置截成 852B）。
- 写前验证合法性 + swap 原子写；替换失败则拒绝操作。
"""
import json, sys, os, io, re

CLAUDE = os.path.expanduser('~/.claude.json')
MAX_CLI = r'D:\自研工具\graft-Max\dist\cli.js'
MAX_ENTRY = {'command': 'node', 'args': [MAX_CLI, 'mcp']}
ORIG_ENTRY = {'command': 'npx', 'args': ['-y', '@nanonets/graft', 'mcp']}
BS = chr(92)  # backslash

def entry_json(entry):
    return json.dumps(entry, ensure_ascii=False)

def find_graft_entry_span(raw):
    """定位 mcpServers.graft 值的 (start,end) 字节区间；无则 None。"""
    m = re.search(r'"mcpServers"\s*:\s*\{', raw)
    if not m: return None
    i = m.end()
    depth = 1; ins = False; esc = False
    while i < len(raw):
        ch = raw[i]
        if esc: esc = False
        elif ch == BS: esc = True
        elif ch == '"': ins = not ins
        elif not ins:
            if ch == '{': depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0: return None
            elif ch == ':' and depth == 1:
                key_m = re.search(r'"([^"]+)"\s*$', raw[m.end():i])
                if key_m and key_m.group(1) == 'graft':
                    j = i + 1
                    while j < len(raw) and raw[j] in ' \t': j += 1
                    if j < len(raw) and raw[j] == '{':
                        d2 = 1; k = j + 1; ins2 = False; e2 = False
                        while k < len(raw):
                            c2 = raw[k]
                            if e2: e2 = False
                            elif c2 == BS: e2 = True
                            elif c2 == '"': ins2 = not ins2
                            elif not ins2:
                                if c2 == '{': d2 += 1
                                elif c2 == '}':
                                    d2 -= 1
                                    if d2 == 0: return (j, k + 1)
                            k += 1
                        return None
                    return None
        i += 1
    return None

def set_graft(entry):
    raw = io.open(CLAUDE, encoding='utf-8').read()
    json.loads(raw)  # 先验证可解析
    span = find_graft_entry_span(raw)
    if span:
        s, e = span
        new = raw[:s] + entry_json(entry) + raw[e:]
    else:
        m = re.search(r'("mcpServers"\s*:\s*\{)', raw)
        if not m:
            print('x .claude.json 无 mcpServers 块，拒绝操作')
            sys.exit(1)
        new = raw[:m.end()] + '\n   "graft": ' + entry_json(entry) + ',' + raw[m.end():]
    json.loads(new)  # 写前验证
    tmp = CLAUDE + '.swaptmp'
    io.open(tmp, 'w', encoding='utf-8').write(new)
    os.replace(tmp, CLAUDE)

def current():
    d = json.loads(io.open(CLAUDE, encoding='utf-8').read())
    g = (d.get('mcpServers') or {}).get('graft')
    if not g: return 'none'
    if g.get('command') == 'node' and any('graft-Max' in a for a in g.get('args', [])): return 'max'
    return 'orig'

def status():
    cur = current()
    name = {'max': 'graft-Max（自研版）', 'orig': '原版（npx @nanonets/graft）', 'none': '未注册'}[cur]
    print(f'当前 MCP graft 槽位: {name}')
    try:
        import urllib.request
        urllib.request.urlopen('http://127.0.0.1:24688/stats', timeout=2)
        print('Dashboard: http://127.0.0.1:24688 运行中')
    except Exception:
        print('Dashboard: 未运行（GRAFT_MAX_UI=1 的会话启动时才会开）')

if __name__ == '__main__':
    m = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if m == 'max':
        set_graft(MAX_ENTRY); print('OK 已切到 graft-Max。新会话生效。'); status()
    elif m == 'orig':
        set_graft(ORIG_ENTRY); print('OK 已切回原版 graft。新会话生效。'); status()
    else:
        status()
