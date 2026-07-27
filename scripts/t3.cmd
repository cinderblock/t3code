@echo off
rem Win+R entry point for the T3 Code diagnostic launcher.
rem
rem Win+R cannot run a .ps1 directly (Windows opens it in an editor), so this
rem thin wrapper exists purely to be pasteable as a full path:
rem
rem   C:\Users\camer\git\t3code\scripts\t3.cmd
rem   C:\Users\camer\git\t3code\scripts\t3.cmd -CpuProf
rem   C:\Users\camer\git\t3code\scripts\t3.cmd -NetLog -LagMs 100
rem
rem Elevation, the cd to the repo root, and the stale-bundle rebuild all happen
rem in start-t3.ps1. Arguments are forwarded verbatim.
setlocal
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-t3.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-t3.ps1" %*
)
exit /b %ERRORLEVEL%
