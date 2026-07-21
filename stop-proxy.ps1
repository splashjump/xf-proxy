# xf-proxy 停止脚本（通过 nssm 服务）
# 双击 stop-proxy.bat 调用，自动 UAC 提权后停止 xf-proxy 服务

$ErrorActionPreference = "Stop"
$svcName = "xf-proxy"

# 自动 UAC 提权（Stop-Service 需要管理员）
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "服务 $svcName 未安装" -ForegroundColor Yellow
    pause
    exit 0
}

if ($svc.Status -ne "Running") {
    Write-Host "xf-proxy 服务未在运行" -ForegroundColor Green
    pause
    exit 0
}

Write-Host "停止 xf-proxy 服务 ..." -ForegroundColor Cyan
Stop-Service -Name $svcName -Force
Start-Sleep -Seconds 1
Write-Host "✓ 已停止 xf-proxy 服务" -ForegroundColor Green
pause
