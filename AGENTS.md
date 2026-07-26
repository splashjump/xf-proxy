# agents.md

项目记忆——给 AI agent 的当前有效规则。历史变更叙事已删除（见 git log）。

## 架构事实

- **Windows nssm 服务**（非 Linux systemd）。默认服务名 `xf-proxy`，开机自启 + 崩溃自动重启。
- **所有配置在根目录 `.env`**（从 `.env.example` 复制，已 gitignore）。`xunfei-proxy.js` 启动时自动加载，不覆盖已存在的环境变量。
- **代理运行参数（API Key / 重试 / 日志）全部走 `.env`**；nssm 只管进程 / 日志重定向 / 重启策略，`service.ps1` 不再注入 envVars。

## 改动后如何生效（最易踩坑）

| 改动 | 生效命令 |
|------|---------|
| `.env`（端口 / 重试 / API Key / 日志等） | `Restart-Service xf-proxy`（node 重启自读 .env） |
| `xunfei-proxy.js` 代理代码 | `Restart-Service xf-proxy` |
| nssm 层配置（服务名 / node 路径 / 日志重定向） | `.\service.ps1 install`（管理员，或双击 `script\install-proxy.bat`） |
| pi 扩展 `xf-proxy-status.ts` | 见 `pi-extension/AGENTS.md`（**运行路径 ≠ 编辑路径**，必须 cp 覆盖到全局 + `/reload`） |

> 旧坑「改 .env 必须 reinstall」已随 .env 改造消除；不要再把运行参数塞进 nssm。

## 排查速查

- 服务状态：`.\service.ps1 status`
- 健康检查：`Invoke-RestMethod http://127.0.0.1:3000/health`
- 实时事件：`Get-Content logs\proxy-events.jsonl -Wait -Tail 20 -Encoding UTF8`
- 实时运行日志：`Get-Content logs\proxy-stdout.log -Wait -Tail 20 -Encoding UTF8`（仅 failed/fatal 进 `logs\proxy-stderr.log`）

## 已知根因（避免重复排查）

- **pi footer 上下文百分比多轮间反复跳变（40%↔20%）**：根因是讯飞 prompt cache 在多轮递增场景下偶尔命中更大的历史缓存，把 `cacheRead` 虚报进 `totalTokens`，cache 失效后回落。**非代理 / pi 问题，无需排查代理侧**。代理已透传 usage 事件（`{t:"usage", reqBytes, in, cached, total}`），可在 `proxy-events.jsonl` 对比 `reqBytes` vs `total` 坐实。
- **pi 扩展「改了没生效」**：99% 是没把编辑处文件覆盖到全局运行处（`~/.pi/agent/extensions/xf-proxy-status.ts`）。先 diff 两份再改，详见 `pi-extension/AGENTS.md`。
- **思考参数注入（`enable_thinking` / `reasoning_effort`）**：讯飞不同模型认不同字段——`xopglm52`(GLM-5.2) 认 `reasoning_effort`（缺则不思考；`"none"` 关，其它非 none 值开），`xopkimik26`(Kimi K2) 认 `enable_thinking`。`injectThinking()` 统一注入两者以兼容两种风格：默认 `enable_thinking=true` + `reasoning_effort` 保留客户端原值(如 `max`)/未传则补 `"high"`；检测到关闭意愿(`reasoning_effort="none"` 或 `enable_thinking=false`)时两者都设关闭。simple 级 `think_inject` 日志展示 `原值→现值` 转换。客户端(pi/opencode)不发 `enable_thinking`，故由代理兜底注入——否则 kimi26 在 pi 设思考强度时反而不思考。
