Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & "C:\inetpub\wwwroot\imageserver\start-image-server-production.bat" & Chr(34), 0
Set WshShell = Nothing