@echo off
REM Local bless CLI (Windows). Usage: bless.cmd reset --yes  OR  .\bless reset --yes
setlocal
cd /d "%~dp0"
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\cli\index.ts" %*
