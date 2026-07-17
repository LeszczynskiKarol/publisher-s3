# Publisher — start serwera node + frpc (publish.torweb.pl)
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'publisher' }
if (-not $node) {
    Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "$root\server.js" -WorkingDirectory $root
}

$frpc = Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" |
    Where-Object { $_.CommandLine -match 'publisher' }
if (-not $frpc) {
    Start-Process -WindowStyle Hidden -FilePath "C:\Users\Admin\frp\frp_0.61.1_windows_amd64\frpc.exe" `
        -ArgumentList "-c", "$root\frpc.toml"
}

Write-Host "Publisher: http://localhost:4900  |  https://publish.torweb.pl"
