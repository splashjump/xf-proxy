# agents.md

项目记忆——给 AI agent 的当前有效规则。历史变更叙事已删除（见 git log）。

## 架构事实

- **Windows nssm 服务**（非 Linux systemd）。默认服务名 `xf-proxy`，开机自启 + 崩溃自动重启。
- **所有配置在根目录 `.env`**（从 `.env.example` 复制，已 gitignore）。`xunfei-proxy.js` 启动时自动加载，不覆盖已存在的环境变量。
- **代理运行参数（API Key / 重试 / 日志）全部走 `.env`**；nssm 只管进程 / 日志重定向 / 重启策略，`service.ps1` 不再注入 envVars。
- **运行环境**：Node.js ≥ 18（用到全局 `fetch` / `AbortController` / `AbortSignal.timeout`，均 Node 18+ 内置）；零依赖，无需 `npm install`。

## 特性

- **Windows 系统服务**（nssm）：开机自启 + 崩溃自动重启
- **固定间隔重试**：0.5s ±15% 抖动，每 10 次连续失败冷却 5s，上限 50 次，成功刷新计数
- **可重试状态**：429 / 502 / 503 / 504
- **三级日志**：none / simple / full
- **结构化事件日志**：供 pi 扩展实时显示代理状态

## 目录结构

```
xunfei-proxy.js        代理脚本
.env / .env.example    配置（.env 不提交）
service.ps1            服务安装/卸载/状态（逻辑核心，无提权）
script/                双击启动/停止/安装/卸载入口（UAC 提权，包装 service.ps1）
bin/nssm.exe           服务管理工具
logs/                  运行时日志
pi-extension/          pi 扩展（footer 显示代理状态，见其 AGENTS.md）
xf-test/               探针脚本
```

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
| `PI_EVENT_LOG` | 是否写 proxy-events.jsonl 供 pi 扩展读取 | `false` |
| `LOG_DIR` | 日志目录 | `<脚本目录>/logs` |
| `SVC_NAME` | 服务名 | `xf-proxy` |
| `NODE_EXE` | node 路径（留空用 PATH） | — |
| `PROBE_MODEL` | 探针默认模型 | `xopglm52` |

## 改动后如何生效（最易踩坑）

| 改动 | 生效命令 |
|------|---------|
| `.env`（端口 / 重试 / API Key / 日志等） | `Restart-Service xf-proxy`（node 重启自读 .env） |
| `xunfei-proxy.js` 代理代码 | `Restart-Service xf-proxy` |
| nssm 层配置（服务名 / node 路径 / 日志重定向） | `.\service.ps1 install`（管理员，或双击 `script\install-proxy.bat`） |
| pi 扩展 `xf-proxy-status.ts` | 见 `pi-extension/AGENTS.md`（**运行路径 ≠ 编辑路径**，必须 cp 覆盖到全局 + `/reload`） |

> 旧坑「改 .env 必须 reinstall」已随 .env 改造消除；不要再把运行参数塞进 nssm。

## 管理命令

| 操作 | 命令 |
|------|------|
| 启动 | `Start-Service xf-proxy`（管理员）或双击 `script\start-proxy.bat` |
| 停止 | `Stop-Service xf-proxy`（管理员）或双击 `script\stop-proxy.bat` |
| 重启 | `Restart-Service xf-proxy`（管理员） |
| 状态 | `.\service.ps1 status` 或 `Get-Service xf-proxy` |
| 安装/刷新 | `.\service.ps1 install`（管理员）或双击 `script\install-proxy.bat` |
| 卸载 | `.\service.ps1 uninstall`（管理员）或双击 `script\uninstall-proxy.bat` |
| 健康检查 | `Invoke-RestMethod http://127.0.0.1:3000/health` |

> 改 `.env` 后只需 `Restart-Service` 即生效；仅当改了 nssm 层配置（服务名、node 路径、日志重定向）才需重新 `install`。

## 日志

| 文件 | 内容 |
|------|------|
| `logs/proxy-events.jsonl` | 结构化事件（仅 `PI_EVENT_LOG=true` 时写，滚动；供 pi 扩展读取） |
| `logs/proxy-stdout.log` | 可读运行日志（nssm 重定向 stdout；simple/full 级，含启动/重试/成功） |
| `logs/proxy-stderr.log` | 可读错误日志（nssm 重定向 stderr；simple/full 级，仅 failed/fatal） |
| `logs/proxy.log` | 完整请求/响应明文（仅 full 级） |

实时跟踪：

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

## 已知根因（避免重复排查）

- **pi footer 上下文百分比多轮间反复跳变（40%↔20%）**：根因是讯飞 prompt cache 在多轮递增场景下偶尔命中更大的历史缓存，把 `cacheRead` 虚报进 `totalTokens`，cache 失效后回落。**非代理 / pi 问题，无需排查代理侧**。代理已透传 usage 事件（`{t:"usage", reqBytes, in, cached, total}`），可在 `proxy-events.jsonl` 对比 `reqBytes` vs `total` 坐实。
- **pi 扩展「改了没生效」**：99% 是没把编辑处文件覆盖到全局运行处（`~/.pi/agent/extensions/xf-proxy-status.ts`）。先 diff 两份再改，详见 `pi-extension/AGENTS.md`。
- **思考参数注入（`enable_thinking` / `reasoning_effort`）**：讯飞不同模型认不同字段——`xopglm52`(GLM-5.2) 认 `reasoning_effort`（缺则不思考；`"none"` 关，其它非 none 值开），`xopkimik26`(Kimi K2) 认 `enable_thinking`。`injectThinking()` 统一注入两者以兼容两种风格：默认 `enable_thinking=true` + `reasoning_effort` 保留客户端原值(如 `max`)/未传则补 `"high"`；检测到关闭意愿(`reasoning_effort="none"` 或 `enable_thinking=false`)时两者都设关闭。simple 级 `think_inject` 日志展示 `原值→现值` 转换。客户端(pi/opencode)不发 `enable_thinking`，故由代理兜底注入——否则 kimi26 在 pi 设思考强度时反而不思考。
