# Local bless CLI (PowerShell). Usage: .\bless reset --yes
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  & node "$root\node_modules\tsx\dist\cli.mjs" "$root\src\cli\index.ts" @args
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
