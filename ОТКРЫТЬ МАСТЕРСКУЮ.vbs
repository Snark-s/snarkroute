Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\start-launcher.bat""", 0, False
