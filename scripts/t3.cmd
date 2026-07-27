@echo off
rem T3 Code diagnostic launcher -- the ONLY thing Cameron runs:
rem
rem     C:\Users\camer\git\t3code\scripts\t3.cmd
rem
rem No arguments. Ever. Whatever diagnostics a given debugging session needs
rem (CPU profiling, netlog, stall threshold, rebuild policy) is configured by
rem Claude in the RUN CONFIGURATION block of start-t3.ps1 and committed.
rem
rem This wrapper exists only because Win+R cannot execute a .ps1 -- Windows
rem opens it in an editor instead.
setlocal
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-t3.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-t3.ps1"
)
exit /b %ERRORLEVEL%
