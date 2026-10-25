param(
    [switch]$Foreground,
    [switch]$Kill
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
Set-Location $scriptDir

# Clean any stale background instance so the new one opens cleanly
Get-WmiObject Win32_Process -ErrorAction SilentlyContinue | Where-Object { 
    $_.Name -like "*powershell*" -and $_.CommandLine -like "*isle-windows.ps1*" 
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($Kill) {
    Write-Host "[Isle] Dynamic Island telah dihentikan." -ForegroundColor Yellow
    exit 0
}

Write-Host "[Isle] Memeriksa daemon..." -ForegroundColor Cyan
if (-not (Test-Path "$scriptDir\target\release\isled.exe")) {
    Write-Host "[Isle] Mengompilasi isled backend..." -ForegroundColor Yellow
    cargo build --release -p isle-daemon
}

# Start isled if not running
$runningIsled = Get-Process -Name isled -ErrorAction SilentlyContinue
if (-not $runningIsled) {
    Write-Host "[Isle] Menjalankan Isle Daemon di background..." -ForegroundColor Green
    Start-Process -FilePath "$scriptDir\target\release\isled.exe" -WindowStyle Hidden
} else {
    Write-Host "[Isle] Isle Daemon sudah aktif di background." -ForegroundColor Gray
}

if ($Foreground) {
    Write-Host "[Isle] Menjalankan Dynamic Island di foreground (tekan Esc atau Ctrl+C untuk keluar)..." -ForegroundColor Green
    & "$scriptDir\isle-windows.ps1"
} else {
    Write-Host "[Isle] Menampilkan Dynamic Island asli di atas layar..." -ForegroundColor Green
    $targetScript = Join-Path $scriptDir "isle-windows.ps1"
    $cmd = "powershell.exe -STA -ExecutionPolicy Bypass -NoProfile -File `"$targetScript`""
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
    if ($null -ne $res -and $res.ReturnValue -eq 0) {
        Write-Host "==============================================================" -ForegroundColor Magenta
        Write-Host "[Isle] Berhasil dijalankan! (PID: $($res.ProcessId))" -ForegroundColor Green
        Write-Host "Notch Dynamic Island asli (Music, Focus, Reminders, Shelf," -ForegroundColor White
        Write-Host "Calendar, Notifications, Usage) sudah aktif mekar di atas layar." -ForegroundColor White
        Write-Host "Arahkan kursor ke notch hitam di bagian atas tengah layar untuk berinteraksi." -ForegroundColor Gray
        Write-Host "==============================================================" -ForegroundColor Magenta
    } else {
        $p = Start-Process powershell.exe -ArgumentList @("-STA", "-ExecutionPolicy", "Bypass", "-NoProfile", "-File", $targetScript) -PassThru
        Write-Host "[Isle] Berhasil dijalankan via Start-Process (PID: $($p.Id))" -ForegroundColor Green
    }
}
