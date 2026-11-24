Option Explicit

Dim shell, fso, scriptDir, port, url, pyCmd, psCmd, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
port = 8742
url = "http://127.0.0.1:" & port

Function IsHomeVaultRunning(checkUrl)
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.XMLHTTP")
  End If
  http.Open "GET", checkUrl & "/manifest.webmanifest", False
  http.Send
  If Err.Number = 0 And http.Status = 200 Then
    IsHomeVaultRunning = True
  Else
    IsHomeVaultRunning = False
  End If
  Err.Clear
  On Error GoTo 0
End Function

' Falls HomeVault bereits laeuft, nur Browser oeffnen (keine doppelte Instanz)
If IsHomeVaultRunning(url) Then
  shell.Run url, 1, False
  WScript.Quit 0
End If

' Python suchen (py -> python -> python3)
pyCmd = ""
If shell.Run("cmd /c where py >nul 2>&1", 0, True) = 0 Then
  pyCmd = "py -3"
ElseIf shell.Run("cmd /c where python >nul 2>&1", 0, True) = 0 Then
  pyCmd = "python"
ElseIf shell.Run("cmd /c where python3 >nul 2>&1", 0, True) = 0 Then
  pyCmd = "python3"
End If

shell.CurrentDirectory = scriptDir

If pyCmd <> "" Then
  ' Unsichtbar im Hintergrund starten (WindowStyle 0, WaitOnReturn False)
  shell.Run pyCmd & " -m http.server " & port & " --bind 127.0.0.1 --directory """ & scriptDir & """", 0, False
Else
  ' Integrierter Windows-PowerShell-HTTP-Server als unsichtbarer Fallback (kein Python noetig)
  psCmd = "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command " & _
    """$root='" & Replace(scriptDir, "'", "''") & "';" & _
    "$l=New-Object System.Net.HttpListener;$l.Prefixes.Add('http://127.0.0.1:" & port & "/');$l.Start();" & _
    "$m=@{'.html'='text/html; charset=utf-8';'.css'='text/css; charset=utf-8';'.js'='application/javascript; charset=utf-8';'.json'='application/json; charset=utf-8';'.webmanifest'='application/manifest+json; charset=utf-8';'.svg'='image/svg+xml';'.png'='image/png';'.ico'='image/x-icon';'.wasm'='application/wasm';'.woff2'='font/woff2';'.woff'='font/woff'};" & _
    "try{while($l.IsListening){$c=$l.GetContext();$r=[Uri]::UnescapeDataString($c.Request.Url.AbsolutePath.TrimStart('/'));if(!$r){$r='index.html'};$f=[System.IO.Path]::GetFullPath((Join-Path $root $r));if($f.StartsWith($root) -and (Test-Path $f -PathType Leaf)){$e=[System.IO.Path]::GetExtension($f).ToLower();$c.Response.ContentType=if($m.ContainsKey($e)){$m[$e]}else{'application/octet-stream'};$b=[System.IO.File]::ReadAllBytes($f);$c.Response.ContentLength64=$b.Length;$c.Response.OutputStream.Write($b,0,$b.Length)}else{$c.Response.StatusCode=404};$c.Response.OutputStream.Close()}}finally{$l.Stop()}"""
  shell.Run psCmd, 0, False
End If

' Kurz warten, bis der lokale Server bereit ist (max. ~2,5 Sekunden)
For i = 1 To 10
  WScript.Sleep 250
  If IsHomeVaultRunning(url) Then Exit For
Next

shell.Run url, 1, False
WScript.Quit 0
