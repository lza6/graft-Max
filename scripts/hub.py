# -*- coding: utf-8 -*-
# graft-Max Hub: unified dashboard entry. Windows-safe alive check via tasklist.
import json, os, io, subprocess, http.server, socketserver

PORT = 24680
SESSIONS = os.path.join(os.path.expanduser('~'), '.graft-max', 'sessions.json')

def alive_pids():
    """One tasklist call for all pids (Windows os.kill(pid,0) is unreliable — WinError 87)."""
    try:
        out = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True, text=True, timeout=10).stdout
        return set(int(line.split('","')[1]) for line in out.splitlines() if '","' in line)
    except Exception:
        return set()

def sessions():
    try:
        rows = json.load(io.open(SESSIONS, encoding='utf-8'))
    except Exception:
        return []
    pids = alive_pids()
    return [r for r in rows if not r.get('endedAt') and r.get('pid', 0) in pids]

PAGE = '''<!doctype html><html lang="zh" data-theme="dark"><head><meta charset="utf-8">
<title>graft-Max Hub</title><meta http-equiv="refresh" content="5">
<style>
body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;background:#0E1012;color:#E7E9EA;margin:0;padding:24px}
h1{font-size:17px} .muted{color:#8B9298;font-size:12px}
table{border-collapse:collapse;width:100%;margin-top:12px}
td,th{border:1px solid #252B30;padding:7px 12px;text-align:left}
th{background:#15181B;color:#7B8FFF}
.live{color:#57C98B;font-weight:600} .mono{font-family:Consolas,monospace;font-size:12px}
</style></head><body>
<h1>graft-Max Hub - all live sessions</h1>
<div class="muted">refresh every 5s</div>
<table><tr><th>status</th><th>pid</th><th>user</th><th>repo (cwd)</th><th>host pid</th><th>requests</th><th>started</th></tr>
__ROWS__
</table></body></html>'''

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        rows = []
        for s in sessions():
            rows.append(
                "<tr><td class='live'>&#9679; LIVE</td><td class='mono'>%s</td>"
                "<td>%s</td><td class='mono'>%s</td>"
                "<td class='muted'>%s</td><td>%s</td>"
                "<td class='muted'>%s</td></tr>" % (
                    s.get('pid', '?'), s.get('user', '?'),
                    s.get('cwd', '?'), s.get('hostPid', '?'),
                    s.get('requests', 0), str(s.get('startedAt', '?'))[:19]))
        html = PAGE.replace('__ROWS__', '\n'.join(rows) or '<tr><td colspan=7 class=muted>no live sessions</td></tr>')
        self.send_response(200)
        self.send_header('content-type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(html.encode('utf-8'))

    def log_message(self, *a):
        pass

if __name__ == '__main__':
    with socketserver.TCPServer(('127.0.0.1', PORT), H) as httpd:
        print('graft-Max Hub: http://127.0.0.1:%d' % PORT)
        httpd.serve_forever()
