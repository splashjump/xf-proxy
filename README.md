# xf-proxy

讯飞星辰 API 本地代理，自定义重试策略，注册为 Windows 系统服务。

```
客户端 → localhost:3000/v1 → xunfei-proxy(重试) → 讯飞星辰 v2 API
```

## 特性

- **Windows 系统服务**（nssm）：开机自启 + 崩溃自动重启
- **固定间隔重试**：0.5s ±15% 抖动，每 10 次连续失败冷却 5s，上限 50 次，成功刷新计数
- **可重试状态**：429 / 502 / 503 / 504
- **三级日志**：none / simple / full
- **结构化事件日志**：供 pi 扩展实时显示代理状态

## 快速开始

```powershell
# 1. 从模板创建配置，填入讯飞 API Key
Copy-Item .env.example .env
notepad .env   # 填 XFYUN_API_KEY

# 2. 安装服务（管理员；或双击 script\install-proxy.bat）
.\service.ps1 install

# 3. 验证
Invoke-RestMethod http://127.0.0.1:3000/health
# → {"status":"ok"}
```

## 配置

所有配置在根目录 `.env`（见 `.env.example`，不提交 git）：

| 变量 | 说明 | 默认 |
|------|------|------|
| `XFYUN_API_KEY` | 讯飞 API Key（必填） | — |
| `XFYUN_BASE_URL` | 上游地址 | `https://maas-coding-api.cn-huabei-1.xf-yun.com/v2` |
| `PROXY_PORT` | 监听端口 | `3000` |
| `RETRY_DELAY_MS` | 重试间隔 ms | `500` |
| `MAX_RETRIES` | 最大重试次数 | `50` |
| `COOLDOWN_AFTER` | 触发冷却的连续失败次数 | `10` |
| `COOLDOWN_MS` | 冷却时长 ms | `5000` |
| `LOG_LEVEL` | none / simple / full | `simple` |
| `EVENT_LOG_MAX_LINES` | 事件日志滚动行数 | `1000` |
| `LOG_DIR` | 日志目录 | `<脚本目录>/logs` |
| `SVC_NAME` | 服务名 | `xf-proxy` |
| `NODE_EXE` | node 路径（留空用 PATH） | — |
| `PROBE_MODEL` | 探针默认模型 | `xopglm52` |

## 管理命令

| 操作 | 命令 |
|------|------|
| 启动 | `Start-Service xf-proxy`（管理员）或 `.\start-proxy.ps1` |
| 停止 | `Stop-Service xf-proxy`（管理员）或 `.\stop-proxy.ps1` |
| 重启 | `Restart-Service xf-proxy`（管理员） |
| 状态 | `.\service.ps1 status` 或 `Get-Service xf-proxy` |
| 安装/刷新 | `.\service.ps1 install`（管理员）或双击 `script\install-proxy.bat` |
| 卸载 | `.\service.ps1 uninstall`（管理员）或双击 `script\uninstall-proxy.bat` |
| 健康检查 | `Invoke-RestMethod http://127.0.0.1:3000/health` |

> 改 `.env` 后只需 `Restart-Service` 即生效；仅当改了 nssm 层配置（服务名、node 路径、日志重定向）才需重新 `install`。

## 日志

| 文件 | 内容 |
|------|------|
| `logs/proxy-events.jsonl` | 结构化事件（始终写，滚动；供 pi 扩展读取） |
| `logs/proxy-stdout.log` | 可读运行日志（nssm 重定向 stdout；simple/full 级，含启动/重试/成功） |
| `logs/proxy-stderr.log` | 可读错误日志（nssm 重定向 stderr；simple/full 级，仅 failed/fatal） |
| `logs/proxy.log` | 完整请求/响应明文（仅 full 级） |

```powershell
Get-Content logs\proxy-events.jsonl -Wait -Tail 20 -Encoding UTF8
Get-Content logs\proxy-stdout.log -Wait -Tail 20 -Encoding UTF8
```

> `full` 级会记录完整对话明文，仅用于调试，排查完建议切回 `none`/`simple`。

## 客户端配置

OpenCode（`~/.config/opencode/opencode.jsonc`）：

```json
"options": {
  "baseURL": "http://localhost:3000/v1",
  "apiKey": "local-proxy"
}
```

## 目录结构

```
xunfei-proxy.js        代理脚本
.env / .env.example    配置（.env 不提交）
service.ps1            服务安装/卸载/状态
start-proxy.ps1        启动封装
stop-proxy.ps1         停止封装
script/                双击安装/卸载入口（UAC 提权）
bin/nssm.exe           服务管理工具
logs/                  运行时日志
pi-extension/          pi 扩展（footer 显示代理状态，见其 AGENTS.md）
xf-test/               探针脚本
```
