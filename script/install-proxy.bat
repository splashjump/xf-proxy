@echo off
chcp 65001 >nul
REM Install/refresh xf-proxy service (auto UAC elevation)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-proxy.ps1"
