# xunfei-proxy 使用说明（Windows 版）

## 是什么

轻量本地代理，OpenCode ↔ 讯飞星辰 API 之间转发，自定义重试策略。

```
OpenCode  →  localhost:3000/v1  →  xunfei-proxy(重试)  →  讯飞星辰 v2 API
```

## 配置

所有配置集中在根目录 **`.env`**（从 `.env.example` 复制，填入真实值；`.env` 不提交 git）。`xunfei-proxy.js` 启动时自动加载，不覆盖已存在的环境变量。

| 变量 | 说明 | 默认 |
|------|------|------|
| `XFYUN_API_KEY` | 讯飞 API Key（必填） | — |
| `XFYUN_BASE_URL` | 上游地址 | `https://maas-coding-api.cn-huabei-1.xf-yun.com/v2` |
| `PROXY_PORT` | 监听端口 | `3000` |
| `RETRY_DELAY_MS` | 固定重试间隔 ms | `500` |
| `MAX_RETRIES` | 最大重试次数 | `50` |
| `COOLDOWN_AFTER` | 连续失败多少次触发冷却 | `10` |
| `COOLDOWN_MS` | 冷却时长 ms | `5000` |
| `LOG_LEVEL` | `none` / `simple` / `full` | `none` |
| `EVENT_LOG_MAX_LINES` | 结构化事件日志滚动行数 | `1000` |
| `LOG_DIR` | 日志目录 | `<脚本目录>/logs` |
| `SVC_NAME` | Windows 服务名（service.ps1 用） | `xf-proxy` |
| `NODE_EXE` | node 绝对路径（留空用 PATH） | — |
| `PROBE_MODEL` | 探针脚本默认模型 | `xopglm52` |

## 运行方式

通过 **nssm** 注册为 Windows 系统服务（默认名 `xf-proxy`）：

- 开机自启（`SERVICE_AUTO_START`）
- 进程崩溃自动重启（nssm `AppExit` 2s + Windows SCM `sc failure` 5/10/30s 兜底）
- 不依赖登录会话（用户没登录也在跑）

```powershell
# 首次：从模板创建 .env 并填入 API Key
Copy-Item .env.example .env
notepad .env

# 以管理员安装服务
.\service.ps1 install
```

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
| 启动 | `.\start-proxy.ps1`，或 `Start-Service xf-proxy`（管理员） |
| 停止 | `.\stop-proxy.ps1`，或 `Stop-Service xf-proxy`（管理员） |
| 重启 | `Restart-Service xf-proxy`（管理员） |
| 状态 | `Get-Service xf-proxy` 或 `.\service.ps1 status` |
| 安装/刷新 | `.\service.ps1 install`（管理员） |
| 卸载 | `.\service.ps1 uninstall`（管理员） |
| 健康检查 | `Invoke-RestMethod http://127.0.0.1:3000/health` |

**平时无需手动启动**：服务已设开机自启 + 崩溃重启。

> 改 `.env` 后只需 `Restart-Service` 即可生效（node 重启时自行读取 `.env`，无需重新 `install`）。仅当改了 nssm 层配置（服务名、node 路径、日志重定向）才需重新 `.\service.ps1 install`。

## 验证

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
# → {"status":"ok"}
```

## 日志

三级可配日志，通过 `.env` 的 `LOG_LEVEL` 控制：

| 级别 | 说明 |
|------|------|
| `none` | 无 stderr 输出（结构化 `proxy-events.jsonl` 始终写入） |
| `simple` | 重试/错误信息写 stderr（nssm → `proxy-stderr.log`）+ 结构化事件 |
| `full` | 在 simple 基础上，将**完整请求/响应内容**写入 `logs\proxy.log` |

**结构化事件日志** `logs\proxy-events.jsonl`（始终写入，滚动 1000 行，通过 `EVENT_LOG_MAX_LINES` 调节）供 pi 扩展 `xf-proxy-status` 读取，在 pi footer 实时显示代理状态。

```powershell
# 实时跟随（结构化，供机器读取）
Get-Content logs\proxy-events.jsonl -Wait -Tail 20 -Encoding UTF8

# 实时跟随（可读 stderr）
Get-Content logs\proxy-stderr.log -Wait -Tail 20 -Encoding UTF8

# 最近 50 行结构化事件
Get-Content logs\proxy-events.jsonl -Tail 50 -Encoding UTF8

# nssm 重定向的 stderr（V8 致命错误如 OOM，不走 uncaughtException）
Get-Content logs\proxy-stderr.log -Tail 30
```

> 注意：`full` 级会记录完整请求/响应明文，包括对话内容。仅用于调试，排查完建议切回 `none`/`simple`。

## OpenCode 配置

`C:\Users\<user>\.config\opencode\opencode.jsonc`:

```json
"options": {
  "baseURL": "http://localhost:3000/v1",
  "apiKey": "local-proxy"
}
```

## 文件路径

| 文件 | 路径 |
|------|------|
| 代理脚本 | `xunfei-proxy.js` |
| 配置 | `.env`（从 `.env.example` 复制，不提交 git） |
| 服务管理脚本 | `service.ps1`（install / uninstall / status） |
| 启动封装 | `start-proxy.ps1` |
| 停止封装 | `stop-proxy.ps1` |
| nssm.exe | `bin\nssm.exe` |
| 事件日志 | `logs\proxy-events.jsonl`（结构化，供 pi 扩展读取） |
| stderr 日志 | `logs\proxy-stderr.log`（可读行，nssm 重定向） |
| full 日志 | `logs\proxy.log`（仅 full 级） |
| 探针脚本 | `xf-test\probe-*.js` |
