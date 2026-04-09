@echo off
:: Veeva Vault Copilot Connector — Setup Launcher
:: Double-click this file to start the guided setup process.

title Veeva Vault Connector - Setup

:: Try PowerShell 7 first, fall back to Windows PowerShell
where pwsh >nul 2>&1
if %ERRORLEVEL% equ 0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
)

:: Keep window open if there was an error
if %ERRORLEVEL% neq 0 (
    echo.
    echo Setup exited with an error. Press any key to close.
    pause >nul
)
