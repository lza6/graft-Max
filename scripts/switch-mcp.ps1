# graft-Max 一键切换（调 python 实现，健壮处理 .claude.json 的大小写重复键）
# 用法: .\switch-mcp.ps1 max|orig|status
param([Parameter(Position=0)][string]$Mode = "status")
python "$PSScriptRoot\switch-mcp.py" $Mode
