# Cria uma impressora no Windows que manda tudo (RAW) para o emulador em 127.0.0.1:9100.
# Assim, sistemas que imprimem pelo NOME da impressora (spooler do Windows) também funcionam.
# Execute no PowerShell COMO ADMINISTRADOR:
#   powershell -ExecutionPolicy Bypass -File .\exemplos\instalar-impressora-windows.ps1

param(
  [string]$Nome  = "Impressora Termica Emulada",
  [int]$Porta    = 9100
)

$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Rode este script como Administrador." -ForegroundColor Red; exit 1 }

$portName = "EMU_127.0.0.1_$Porta"
$driver   = "Generic / Text Only"

if (-not (Get-PrinterDriver -Name $driver -ErrorAction SilentlyContinue)) {
  Write-Host "Instalando driver '$driver'..."
  Add-PrinterDriver -Name $driver
}
if (-not (Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue)) {
  Write-Host "Criando porta TCP/IP $portName ..."
  Add-PrinterPort -Name $portName -PrinterHostAddress "127.0.0.1" -PortNumber $Porta
}
if (Get-Printer -Name $Nome -ErrorAction SilentlyContinue) {
  Write-Host "A impressora '$Nome' ja existe." -ForegroundColor Yellow
} else {
  Add-Printer -Name $Nome -DriverName $driver -PortName $portName
  Write-Host "Impressora '$Nome' criada -> 127.0.0.1:$Porta (RAW)." -ForegroundColor Green
}

# Para remover depois:
#   Remove-Printer -Name "Impressora Termica Emulada"; Remove-PrinterPort -Name "EMU_127.0.0.1_9100"
