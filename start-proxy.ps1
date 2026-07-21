# xf-proxy 启动脚本（通过 nssm 服务）
# 双击 start-proxy.bat 调用，自动 UAC 提权后启动 xf-proxy 服务
# 平时无需手动启动：nssm 服务已设置开机自启 + 崩溃自动重启

$ErrorActionPreference = "Stop"
$svcName = "xf-proxy"

# 自动 UAC 提权（Start-Service 需要管理员）
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "服务 $svcName 未安装，请先以管理员运行: .\service.ps1 install" -ForegroundColor Red
    pause
    exit 1
}

if ($svc.Status -eq "Running") {
    Write-Host "xf-proxy 服务已在运行" -ForegroundColor Green
    pause
    exit 0
}

Write-Host "启动 xf-proxy 服务 ..." -ForegroundColor Cyan
Start-Service -Name $svcName
Start-Sleep -Seconds 2

try {
    $h = Invoke-RestMethod http://127.0.0.1:3000/health -TimeoutSec 5
    Write-Host "✓ 服务运行中，health = $($h.status)" -ForegroundColor Green
} catch {
    Write-Host "✗ health 检查失败: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  排查: Get-Content D:\xf-proxy\logs\proxy-stderr.log -Tail 30" -ForegroundColor Yellow
}
pause
