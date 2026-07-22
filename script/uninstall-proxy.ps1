# script/uninstall-proxy.ps1 - 双击 uninstall-proxy.bat 触发
# 自动 UAC 提权后调用根目录 service.ps1 uninstall（卸载 xf-proxy 服务）

$ErrorActionPreference = "Stop"
try { chcp 65001 > $null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path $here -Parent
$servicePs1 = Join-Path $root "service.ps1"

# 自动 UAC 提权（uninstall 需要管理员）
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

if (-not (Test-Path $servicePs1)) {
    Write-Host "找不到根目录的 service.ps1: $servicePs1" -ForegroundColor Red
} else {
    & $servicePs1 uninstall
}

Write-Host ""
Write-Host "按任意键关闭..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
