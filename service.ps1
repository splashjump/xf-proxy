# xf-proxy Windows 服务管理脚本（nssm 包装）
# 作用：把 xunfei-proxy.js 注册成系统服务，开机自启 + 崩溃/被杀自动重启
#       （类似 linux: systemctl enable + restart on-failure）
# 用法（install/uninstall 需管理员，status 不需要）：
#   .\service.ps1 install     安装/刷新服务
#   .\service.ps1 uninstall   卸载服务
#   .\service.ps1 status      查看服务状态 + 最近运行日志
#
# 配置来源：根目录 .env（SVC_NAME / NODE_EXE / PROXY_PORT）
#   代理自身的运行参数（API Key、重试、日志等）也写在 .env，
#   xunfei-proxy.js 启动时自动读取，本脚本无需、也不应再 nssm set AppEnvironmentExtra。
#   因此：改 .env 后只需 Restart-Service 即可生效（无需重新 install）。

param([Parameter(Position=0)][ValidateSet('install','uninstall','status')]$Action='status')

$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nssm = Join-Path $dir "bin\nssm.exe"

# ── 读取 .env（取本脚本需要的 SVC_NAME / NODE_EXE / PROXY_PORT）──
function Get-EnvVar($key, $default) {
  $envFile = Join-Path $dir ".env"
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith("#")) { continue }
      $eq = $t.IndexOf("=")
      if ($eq -lt 0) { continue }
      $k = $t.Substring(0, $eq).Trim()
      if ($k -eq $key) {
        $v = $t.Substring($eq + 1).Trim()
        $q = $v[0]
        if (($q -eq '"' -or $q -eq "'") -and $v[-1] -eq $q) { $v = $v.Substring(1, $v.Length - 2) }
        return $v
      }
    }
  }
  return $default
}

$svcName = Get-EnvVar "SVC_NAME" "xf-proxy"
$nodeExe = Get-EnvVar "NODE_EXE" ""
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
$port = Get-EnvVar "PROXY_PORT" "3000"
$script = Join-Path $dir "xunfei-proxy.js"
$logDir = Join-Path $dir "logs"
$stdoutLog = Join-Path $logDir "proxy-stdout.log"
$stderrLog = Join-Path $logDir "proxy-stderr.log"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 清理手动启动的漏网 node 进程（防止与 nssm 服务抢端口）
function Stop-ExistingProxy {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*xunfei-proxy.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

switch ($Action) {
  'install' {
    if (-not (Test-Admin)) { Write-Host "需要管理员权限，请右键 PowerShell 以管理员身份运行" -ForegroundColor Red; exit 1 }
    if (-not (Test-Path $nssm))  { Write-Host "找不到 nssm: $nssm" -ForegroundColor Red; exit 1 }
    if (-not (Test-Path $script)){ Write-Host "找不到代理脚本: $script" -ForegroundColor Red; exit 1 }
    if (-not (Test-Path (Join-Path $dir ".env"))) { Write-Host "找不到 .env：请从 .env.example 复制并填入 XFYUN_API_KEY" -ForegroundColor Red; exit 1 }
    if (-not $nodeExe -or -not (Test-Path $nodeExe)) { Write-Host "找不到 node：请装 Node.js ≥18（winget install OpenJS.NodeJS.LTS），或在 .env 设 NODE_EXE 指向 node.exe 绝对路径" -ForegroundColor Red; exit 1 }

    Write-Host "1) 停掉旧方式启动的代理（释放端口 $port）..." -ForegroundColor Cyan
    Stop-ExistingProxy | Out-Null
    Start-Sleep -Seconds 1

    # 已有同名服务先删
    if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
      Write-Host "2) 删除已有服务 $svcName ..." -ForegroundColor Cyan
      & $nssm stop $svcName 2>$null | Out-Null
      Start-Sleep -Seconds 1
      & $nssm remove $svcName confirm 2>$null | Out-Null
    }

    Write-Host "3) 安装服务 $svcName ..." -ForegroundColor Cyan
    & $nssm install $svcName $nodeExe $script

    & $nssm set $svcName AppDirectory $dir | Out-Null
    # 不再 nssm set AppEnvironmentExtra：代理运行参数由 .env 提供，node 启动时自行读取。
    # 好处：改 .env 后 Restart-Service 即生效，无需重新 install。
    & $nssm set $svcName AppStdout  $stdoutLog | Out-Null
    & $nssm set $svcName AppStderr  $stderrLog | Out-Null
    & $nssm set $svcName AppRotateFiles 1 | Out-Null
    & $nssm set $svcName AppRotateOnline 1 | Out-Null
    & $nssm set $svcName AppRotateBytes 10485760 | Out-Null   # 10MB 轮转

    & $nssm set $svcName Start SERVICE_AUTO_START | Out-Null          # 开机自启
    & $nssm set $svcName AppExit Default Restart | Out-Null           # 进程退出 → 自动重启
    & $nssm set $svcName AppRestartDelay 2000 | Out-Null              # 2s 后重启

    # 系统级失败恢复（兜底，三层递增）
    sc.exe failure $svcName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null

    Write-Host "4) 启动服务 ..." -ForegroundColor Cyan
    & $nssm start $svcName
    Start-Sleep -Seconds 2

    Write-Host "5) 验证 ..." -ForegroundColor Cyan
    $ok = $false
    for ($i = 1; $i -le 3; $i++) {
      try {
        $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 5
        $ok = $true
        break
      } catch {
        if ($i -lt 3) { Start-Sleep -Seconds 1 }
      }
    }
    if ($ok) {
      Write-Host "✓ 服务运行中，health = $($h.status)" -ForegroundColor Green
    } else {
      Write-Host "✗ health 检查失败（已重试 3 次）" -ForegroundColor Red
      Write-Host "  排查: Get-Service $svcName; Get-Content $stdoutLog,$stderrLog -Tail 30" -ForegroundColor Yellow
    }

    # 旧登录自启 VBS 会和新服务冲突，禁用（重命名为 .bak 可恢复）
    $vbs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\xf-proxy-autostart.vbs"
    if (Test-Path $vbs) {
      Rename-Item $vbs "xf-proxy-autostart.vbs.bak" -Force
      Write-Host "6) 已禁用旧登录自启 VBS（恢复: 改回 .vbs）: $vbs" -ForegroundColor Yellow
    }

    Write-Host "`n完成。管理命令（替代 systemctl）：" -ForegroundColor Green
    Write-Host "  状态:  Get-Service $svcName        (systemctl status)"
    Write-Host "  启动:  Start-Service $svcName      (systemctl start)"
    Write-Host "  停止:  Stop-Service $svcName        (systemctl stop)"
    Write-Host "  重启:  Restart-Service $svcName     (systemctl restart)"
    Write-Host "  卸载:  .\service.ps1 uninstall"
    Write-Host "  运行日志: Get-Content $stdoutLog -Tail 30 -Wait  (错误见 $stderrLog)"
    Write-Host "`n  改配置: 编辑 .env 后 Restart-Service $svcName 即可生效" -ForegroundColor DarkGray
  }

  'uninstall' {
    if (-not (Test-Admin)) { Write-Host "需要管理员权限" -ForegroundColor Red; exit 1 }
    & $nssm stop $svcName 2>$null | Out-Null
    Start-Sleep -Seconds 1
    & $nssm remove $svcName confirm
    Write-Host "服务 $svcName 已卸载" -ForegroundColor Green
    $vbsBak = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\xf-proxy-autostart.vbs.bak"
    if (Test-Path $vbsBak) {
      Rename-Item $vbsBak "xf-proxy-autostart.vbs" -Force
      Write-Host "已恢复登录自启 VBS" -ForegroundColor Yellow
    }
  }

  'status' {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if (-not $svc) { Write-Host "服务 $svcName 未安装" -ForegroundColor Yellow; return }
    $svc | Format-Table Name,Status,StartType -AutoSize
    Write-Host "`n=== 最近运行日志 (stdout) ===" -ForegroundColor Cyan
    if (Test-Path $stdoutLog) { Get-Content $stdoutLog -Tail 15 } else { "(无 stdout 日志)" }
    Write-Host "`n=== 最近错误 (stderr) ===" -ForegroundColor Cyan
    if (Test-Path $stderrLog) { Get-Content $stderrLog -Tail 15 } else { "(无 stderr 日志)" }
  }
}
