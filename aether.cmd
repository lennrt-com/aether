@echo off
REM Local Aether CLI (Windows). Usage: aether.cmd worker  OR  .\aether worker
setlocal
cd /d "%~dp0"
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\cli\index.ts" %*
