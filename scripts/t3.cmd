@echo off
rem T3 Code diagnostic launcher -- the ONLY thing Cameron runs:
rem
rem     C:\Users\camer\git\t3code\scripts\t3.cmd
rem
rem No arguments. Ever. Whatever diagnostics a given debugging session needs
rem (CPU profiling, netlog, stall threshold, rebuild policy) is configured by
rem Claude in the RUN CONFIGURATION block of start-t3.ps1 and committed.
rem
rem This wrapper exists because Win+R cannot execute a .ps1 -- Windows opens it
rem in an editor instead.
rem
rem -WindowStyle Hidden applies to this pre-elevation process only: it exists
rem just long enough to trigger the UAC prompt and exit, so it should never
rem flash a console. The elevated process stays visible while it builds and
rem starts, then hides itself once the app has its own window.
setlocal
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" /b pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-t3.ps1"
) else (
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-t3.ps1"
)
exit /b 0
