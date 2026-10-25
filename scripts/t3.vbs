' Zero-window entry point for the T3 Code diagnostic launcher.
'
' USE THIS ONE FROM Win+R:
'     C:\Users\camer\git\t3code\scripts\t3.vbs
'
' Win+R running a .cmd always spawns a console window to host the batch file,
' regardless of what that batch file then does. wscript runs this with no
' window at all, so the only thing that appears is the UAC prompt and then the
' app itself.
'
' t3.cmd still exists for running from an already-open terminal, where seeing
' the output is useful.
'
' Safe to run while T3 Code is open: start-t3.ps1 installs and builds what is
' needed first, then closes the running app (this build or the installed one)
' and starts the new one. If anything fails, its console comes back and waits.
'
' No arguments, by design. Diagnostics are configured in the RUN CONFIGURATION
' block of start-t3.ps1 and committed.

Dim shell, fso, here, ps1, exe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\start-t3.ps1"

If Not fso.FileExists(ps1) Then
  MsgBox "Launcher not found:" & vbCrLf & ps1, vbCritical, "T3 Code"
  WScript.Quit 1
End If

' pwsh (7+) if present, else Windows PowerShell.
exe = "pwsh"
On Error Resume Next
shell.Run "pwsh -NoProfile -Command exit", 0, True
If Err.Number <> 0 Then exe = "powershell"
On Error Goto 0

' 0 = hidden window, False = do not wait. start-t3.ps1 handles elevation
' itself, so the UAC prompt still appears normally. -KeepOpen makes a failure
' wait for Enter even when the caller is already elevated and the elevation hop
' (which adds it) is skipped.
'
' conhost.exe, because Windows Terminal is the default terminal: a console it
' hosts that starts hidden can never be shown again, so a build or a failure
' happened invisibly (2026-10-25, the logon task after a power cut). Under
' conhost the script can show its console when there is something to watch.
shell.Run "conhost.exe " & exe & " -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """ -KeepOpen", 0, False
