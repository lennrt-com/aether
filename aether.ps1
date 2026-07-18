# Local Aether CLI (Windows PowerShell). Usage: .\aether.ps1 worker
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)
Set-Location -LiteralPath $PSScriptRoot
& node "$PSScriptRoot\node_modules\tsx\dist\cli.mjs" "$PSScriptRoot\src\cli\index.ts" @Args
exit $LASTEXITCODE
