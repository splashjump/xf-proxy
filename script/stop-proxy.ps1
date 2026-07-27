# xf-proxy 停止脚本（通过 nssm 服务）
# 双击或命令行调用，自动 UAC 提权后停止 xf-proxy 服务

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir = Split-Path $here -Parent   # script/ 的父目录 = 仓库根（.env 在根）

# 从 .env 读服务名
function Get-EnvVar($key, $default) {
  $envFile = Join-Path $dir ".env"
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith("#")) { continue }
      $eq = $t.IndexOf("=")
      if ($eq -lt 0) { continue }
      if ($t.Substring(0, $eq).Trim() -eq $key) {
        $v = $t.Substring($eq + 1).Trim()
        $q = $v[0]
        if (($q -eq '"' -or $q -eq "'") -and $v[-1] -eq $q) { $v = $v.Substring(1, $v.Length - 2) }
        return $v
      }
    }
  }
  return $default
}
$svcName = Get-EnvVar "SVC_NAME" "xf-proxy"

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
    Write-Host "$svcName 服务未在运行" -ForegroundColor Green
    pause
    exit 0
}

Write-Host "停止 $svcName 服务 ..." -ForegroundColor Cyan
Stop-Service -Name $svcName -Force
Start-Sleep -Seconds 1
Write-Host "✓ 已停止 $svcName 服务" -ForegroundColor Green
pause
