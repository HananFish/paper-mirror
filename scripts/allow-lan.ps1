# 允许局域网设备访问阅读器（8000 端口）。需要管理员权限，会弹出 UAC 确认框。
# 用法：右键"使用 PowerShell 运行"，或在终端执行 scripts\allow-lan.ps1
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs -WindowStyle Hidden
    exit
}
netsh advfirewall firewall add rule name="文献翻译阅读器 (TCP 8000)" dir=in action=allow protocol=TCP localport=8000
Write-Host "防火墙规则已添加：局域网设备可访问 8000 端口" -ForegroundColor Green
