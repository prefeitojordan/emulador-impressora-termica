@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Baixando o Electron...
  node node_modules\electron\install.js
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
