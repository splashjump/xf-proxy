# script/install-proxy.ps1 - 双击 install-proxy.bat 触发
# 自动 UAC 提权后调用根目录 service.ps1 install（安装/刷新 xf-proxy 服务）

$ErrorActionPreference = "Stop"
# 让中文输出在提权窗口不乱码（console 代码页 + 输出编码都设 UTF-8）
try { chcp 65001 > $null } catch {}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path $here -Parent
$servicePs1 = Join-Path $root "service.ps1"

# 自动 UAC 提权（install 需要管理员）
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

if (-not (Test-Path $servicePs1)) {
    Write-Host "找不到根目录的 service.ps1: $servicePs1" -ForegroundColor Red
} else {
    & $servicePs1 install
}

Write-Host ""
Write-Host "按任意键关闭..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
