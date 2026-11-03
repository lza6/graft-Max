# vendors 统一更新脚本（v1）：逐个 git pull + 提示回归验证
# 用法: .\update-vendors.ps1 [名字]   不带参数=全部
param([Parameter(Position=0)][string]$Name)
$vendors = "D:\自研工具\vendors"
$targets = if ($Name) { @($Name) } else { @("qmd","gitnexus","context-mode","icm","cocoindex-code","serena","context7","chrome-devtools-mcp","modelcontextprotocol-servers") }
foreach ($t in $targets) {
    $p = Join-Path $vendors $t
    if (-not (Test-Path $p)) { Write-Host "SKIP $t (不存在)" -ForegroundColor DarkGray; continue }
    Write-Host "==> $t" -ForegroundColor Cyan
    git -C $p pull --ff-only 2>&1 | Select-Object -First 2
}
Write-Host ""
Write-Host "更新完成。回归验证：" -ForegroundColor Yellow
Write-Host "  cd D:\自研工具\graft-Max; node e2e\e2e-federation.mjs; node e2e\e2e-duck-hub.mjs"
