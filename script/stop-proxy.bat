@echo off
chcp 65001 >nul
REM Stop xf-proxy service (auto UAC elevation)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-proxy.ps1"
