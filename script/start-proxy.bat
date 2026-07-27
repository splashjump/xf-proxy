@echo off
chcp 65001 >nul
REM Start xf-proxy service (auto UAC elevation)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-proxy.ps1"
