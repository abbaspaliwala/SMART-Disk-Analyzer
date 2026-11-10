@echo off
rem Double-clickable launcher for the SMART Disk Analyzer on Windows.
rem Runs bin\run-windows.ps1 with the execution policy bypassed for this call,
rem so no machine-wide policy change is needed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-windows.ps1" %*
if errorlevel 1 pause
