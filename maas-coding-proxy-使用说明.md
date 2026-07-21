# xunfei-proxy 使用说明（Windows 版）

## 是什么

轻量本地代理，OpenCode ↔ 讯飞星辰 API 之间转发，自定义重试策略。

```
OpenCode  →  localhost:3000/v1  →  xunfei-proxy(重试)  →  讯飞星辰 v2 API
```

## 运行方式

通过 **nssm** 注册为 Windows 系统服务（`xf-proxy`）：

- 开机自启（`SERVICE_AUTO_START`）
- 进程崩溃自动重启（nssm `AppExit` 2s + Windows SCM `sc failure` 5/10/30s 兜底）
- 不依赖登录会话（用户没登录也在跑）

## 重试策略

| 参数 | 值 |
|------|-----|
| 退避 | **固定 0.5s**（不指数增长） |
| 抖动 | ±15% |
| 冷却 | 每 10 次连续失败，暂停 5s 再继续 |
| 上限 | 50 次 |
| 刷新 | 任意一次成功后，连续失败计数归零 |
| 可重试 HTTP 状态 | 429、502、503、504 |

## 管理命令

| 操作 | 命令 |
|------|------|
| 启动 | 双击 `start-proxy.bat`，或 `Start-Service xf-proxy`（管理员） |
| 停止 | 双击 `stop-proxy.bat`，或 `Stop-Service xf-proxy`（管理员） |
| 重启 | `Restart-Service xf-proxy`（管理员） |
| 状态 | `Get-Service xf-proxy` 或 `.\service.ps1 status` |
| 安装/刷新 | `.\service.ps1 install`（管理员） |
| 卸载 | `.\service.ps1 uninstall`（管理员） |
| 健康检查 | `Invoke-RestMethod http://127.0.0.1:3000/health` |

`start-proxy.bat` / `stop-proxy.bat` 是 `Start-Service` / `Stop-Service` 的封装，双击会自动 UAC 提权。**平时无需手动启动**：服务已设开机自启 + 崩溃重启。

> 修改代理代码或环境变量后，必须运行 `.\service.ps1 install` 重新安装服务才生效（普通 `Restart-Service` 只重启进程，不会重新写入 nssm 的环境变量）。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
# → {"status":"ok"}
```

## 日志

三级可配日志，通过 `service.ps1` 中 `$envVars` 的 `LOG_LEVEL` 控制：

| 级别 | 说明 |
|------|------|
| `none` | 无 stderr 输出（结构 `proxy-events.jsonl` 始终写入） |
| `simple`（默认） | 重试/错误信息写 stderr（nssm → `proxy-stderr.log`）+ 结构化事件 |
| `full` | 在 simple 基础上，将**完整请求/响应内容**写入 `logs\proxy.log` |

**结构化事件日志** `logs\proxy-events.jsonl`（始终写入，滚动 1000 行，通过 `EVENT_LOG_MAX_LINES` env 调节）供 pi 扩展 `xf-proxy-status` 读取，在 pi footer 实时显示代理状态。

```powershell
# 实时跟随（结构化，供机器读取）
Get-Content D:\xf-proxy\logs\proxy-events.jsonl -Wait -Tail 20 -Encoding UTF8

# 实时跟随（可读 stderr）
Get-Content D:\xf-proxy\logs\proxy-stderr.log -Wait -Tail 20 -Encoding UTF8

# 最近 50 行结构化事件
Get-Content D:\xf-proxy\logs\proxy-events.jsonl -Tail 50 -Encoding UTF8

# nssm 重定向的 stderr（V8 致命错误如 OOM，不走 uncaughtException）
Get-Content D:\xf-proxy\logs\proxy-stderr.log -Tail 30
```

> 注意：`full` 级会记录完整请求/响应明文，包括对话内容。仅用于调试，排查完建议切回 `simple`。

## 自定义参数

编辑 `service.ps1` 中的 `$envVars` 块，改后运行 `.\service.ps1 install` 重新安装服务生效：

```powershell
$envVars = @(
  "XFYUN_API_KEY=...",         # 讯飞 API Key
  "PROXY_PORT=3000",            # 监听端口
  "LOG_LEVEL=simple",           # none / simple / full
  "RETRY_DELAY_MS=500",         # 重试间隔
  "MAX_RETRIES=50",             # 重试上限
  "COOLDOWN_AFTER=10",          # 连续失败多少次触发冷却
  "COOLDOWN_MS=5000"           # 冷却时长
)
```

## OpenCode 配置

`C:\Users\admin\.config\opencode\opencode.jsonc`:

```json
"options": {
  "baseURL": "http://localhost:3000/v1",
  "apiKey": "local-proxy"
}
```

## 文件路径

| 文件 | 路径 |
|------|------|
| 代理脚本 | `D:\xf-proxy\xunfei-proxy.js` |
| 服务管理脚本 | `D:\xf-proxy\service.ps1`（install / uninstall / status） |
| 启动封装 | `D:\xf-proxy\start-proxy.ps1`（+ `start-proxy.bat`） |
| 停止封装 | `D:\xf-proxy\stop-proxy.ps1`（+ `stop-proxy.bat`） |
| nssm.exe | `D:\xf-proxy\bin\nssm.exe` |
| API Key | 写在 `service.ps1` 的 `$envVars` 中 |
| 事件日志 | `D:\xf-proxy\logs\proxy-events.jsonl`（结构化，供 pi 扩展读取） |
| stderr 日志 | `D:\xf-proxy\logs\proxy-stderr.log`（可读行，nssm 重定向） |
| full 日志 | `D:\xf-proxy\logs\proxy.log`（仅 full 级） |
