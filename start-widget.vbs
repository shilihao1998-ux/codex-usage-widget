' Starts the widget with no console window. Point "Start with Windows" at this
' file, or double-click it.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
exe = root & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(exe) Then
  MsgBox "Electron is missing. Run 'npm install' in:" & vbCrLf & root, 16, "Codex Usage Widget"
  WScript.Quit 1
End If

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run """" & exe & """ """ & root & """", 0, False
