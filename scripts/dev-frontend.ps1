# 开发模式：前端 Vite 开发服务器（访问 http://localhost:5173，/api 自动代理到 8000）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location "$root\frontend"
npm run dev
Pop-Location
