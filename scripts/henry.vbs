' Henry from the Start menu on Windows: `bun run dev --app` with no console window, so the
' Henry window is the only thing on the taskbar. Output goes to %TEMP%\henry-dev.log.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.Run "cmd /c bun run scripts/dev.ts --app > ""%TEMP%\henry-dev.log"" 2>&1", 0, False
