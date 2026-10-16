@echo off
setlocal
set "launcher=%~dp0Start-Pi.ps1"
if not exist "%launcher%" (
    echo Missing launcher: "%launcher%"
    echo Put this CMD file beside Start-Pi.ps1 in the public launcher folder.
    pause
    exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%launcher%" -PiDirectory "%~dp0..\pi"
