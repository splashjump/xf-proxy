@echo off
chcp 65001 >nul
REM Uninstall xf-proxy service (auto UAC elevation)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-proxy.ps1"
