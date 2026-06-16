# Reload Machine + User PATH into the current PowerShell session.
$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machine;$user"
Write-Host "PATH refreshed. Try: bless --help"
