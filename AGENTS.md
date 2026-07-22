# agents.md

## 2026-07-15: 手动 nohup 绕过 systemd 导致失控

### 事由
给 xunfei-proxy.js 加 simple 模式持久化日志后，手动 `kill` 旧进程 + `nohup node ... &` 重启，未使用 systemd。

### 问题
- 用户执行 `systemctl stop xf-proxy` 后，代理仍在不断重试上游
- 原因：手动 nohup 启动的进程不受 systemd 管理，systemctl 只能管到 systemd service 定义的那个进程

### 解决
1. `kill` 掉手动 nohup 进程
2. `sudo systemctl start xf-proxy` 正确重启

### 教训
- 凡是有 systemd service 的进程，始终用 `systemctl start/stop/restart`，不要手动 kill + nohup
- 排查进程状态时注意区分 systemd 管理和手动启动的进程（`ps aux | grep` + `systemctl status`）

## 2026-07-19: 改 service.ps1 的 envVars 不会同步到已安装的 nssm 服务

### 事由
修改重试参数（`RETRY_DELAY_MS` 1000→500、`MAX_RETRIES` 200→50）和代理代码后，修改未生效。

### 问题
- `service.ps1` 的 `$envVars` 只在 `install` 动作时写入 nssm 注册表
- 已安装的服务，nssm 里存的环境变量是旧的
- `Restart-Service` 只重启 node 进程，不会重新读取 `service.ps1`，也不会刷新 nssm 配置
- 结果：node 进程加载的是旧代码，nssm 注入的是旧环境变量

### 解决
以管理员运行 `.\service.ps1 install`，它会 stop → remove → install（应用新 envVars）→ start。

### 教训
- 修改 `service.ps1` 的 `$envVars` 或代理代码后，必须 `.\service.ps1 install` 才生效
- `Restart-Service` 仅用于"代码没变、只想重启进程"的场景
- 验证当前生效配置：`& .\bin\nssm.exe get xf-proxy AppEnvironmentExtra`，或看 `logs\proxy-simple.log` 启动横幅里的参数

## 2026-07-21: pi 扩展 xf-proxy-status 把代理状态贴到 footer

### 事由
代理服务化后，想看当前请求过没过只能开终端 `Get-Content -Wait` 跟日志，频繁切窗口很烦。

### 做了什么
在 `.pi/extensions/xf-proxy-status.ts` 写了个 pi 扩展：
- 代理侧：新增结构化事件日志 `logs/proxy-events.jsonl`（始终写，滚动 1000 行），停用旧的 `proxy-simple.log`
- 插件读 JSONL，用 `ctx.ui.setStatus()` **追加**到 pi footer（不替换原生 model/tokens 信息）
- footer 展示**单请求失败进度**：重试时 ✗ 一个个往右堆（冷却处插 `'`），成功时左边塞 `✅ N× 耗时` + 右边保留 ✗ 串战绩并以绿 `✓` 收尾，失败整行红
- idle 时状态文本完全稳定，不触发重绘，不干扰输入
- `/xfproxy [off|N]` 在编辑器下方贴最近 N 行日志 widget（按类型上色）
- 每 10s 探活 `/health`，服务停了（含 `Stop-Service` 不写日志的场景）会显示已停止

### 注意
- 扩展已转为**全局**：`~/.pi/agent/extensions/xf-proxy-status.ts`，所有项目都能用；默认日志路径硬编码 `T:/xf-proxy/logs/proxy-events.jsonl`（项目从 D 盘迁到 T 盘时同步改过，曾因路径没跟手导致插件不生效），可通过 `XF_PROXY_LOG` 环境变量覆盖
- 冷却时长 2026-07-22 从 10s 调为 5s（代码默认 + `service.ps1` envVars 同改）

## 2026-07-22: script/ 双击安装入口（UAC 提权）

### 事由
要上传 git，希望别人 clone 后能双击装服务，不必开 PowerShell 敲 `.\service.ps1 install`。

### 做了什么
- `script/install-proxy.bat` + `install-proxy.ps1`：双击 → ps1 自动 UAC 提权 → 调根目录 `service.ps1 install`
- `script/uninstall-proxy.bat` + `uninstall-proxy.ps1`：同模式调 `uninstall`
- ps1 设 `chcp 65001` + `OutputEncoding=UTF8`，提权窗口中文不乱码

### 注意
- 编码细节：**ps1 存 UTF-8 BOM**（PS 5.1 才能正确读中文字符串/注释）；**bat 纯 ASCII 无 BOM**（cmd 对 BOM 容忍差，首行 `@echo off` 前若有 BOM 会出错）
- 仅 Win；bat 调 `powershell`（5.1，系统自带），不依赖 pwsh 7
- `status` 无双击脚本（只读不需提权，直接 `.\service.ps1 status`）
- ps1 用 `$MyInvocation.MyCommand.Path` 定位自己 → 算根目录 → 找 `service.ps1`，不依赖 cwd（提权后 cwd 是 system32 也能工作）

## 2026-07-22: 配置抽象到 .env，消除 service.ps1 envVars 坑

### 事由
准备把项目上传到 git，需把敏感信息（API Key）、环境信息（node 路径）、配置信息（端口/重试/日志）从代码里抽出来。同时彻底解决 2026-07-19 记录的「改 service.ps1 envVars 不生效」坑。

### 做了什么
- 新增 `.env`（gitignore）+ `.env.example`（提交模板），集中所有配置：`XFYUN_API_KEY` / `XFYUN_BASE_URL` / `PROXY_PORT` / 重试参数 / `LOG_LEVEL` / `SVC_NAME` / `NODE_EXE` / `PROBE_MODEL`
- `xunfei-proxy.js` 头部加零依赖 `.env` loader（不覆盖已存在的环境变量）：开发 `node xunfei-proxy.js` 与 nssm 服务（`AppDirectory=项目目录`）都自动读取
- `service.ps1` **移除 `nssm set AppEnvironmentExtra`**：代理运行参数改由 node 自行读 `.env`，nssm 只管进程/日志/重启策略。脚本自身仅从 `.env` 读 `SVC_NAME`/`NODE_EXE`/`PROXY_PORT`
- `start-proxy.ps1` / `stop-proxy.ps1` 同步从 `.env` 读 `SVC_NAME`/`PROXY_PORT`，并修掉旧版 `D:\xf-proxy\logs\...` 硬编码路径 bug（改用脚本所在目录）
- `xf-test/probe-*.js` 端口改读 `PROXY_PORT`、模型改读 `PROBE_MODEL`（默认 `xopglm52`）
- 使用说明.md 全文 `D:\xf-proxy\` 硬编码路径改为相对路径，「自定义参数」一节改为 `.env` 配置表

### 关键改进：改配置不再需要 install
- 旧流程：改 `service.ps1` 的 `$envVars` → 必须 `install`（因 nssm 注册表存的是旧值，`Restart-Service` 不刷新）
- 新流程：改 `.env` → `Restart-Service` 即生效（node 重启时自己读 `.env`）
- 仅当改了 nssm 层配置（服务名、node 路径、日志重定向路径）才需重新 `install`

### 注意
- `.env` 已加入 `.gitignore`，不会上传；`.env.example` 是模板（API Key 留空）
- nssm 的 `AppDirectory` 必须设为项目目录，否则 node 找不到 `.env`（`service.ps1 install` 已保证）
- clone 后的流程：`Copy-Item .env.example .env` → 填 `XFYUN_API_KEY` → `service.ps1 install`

## 2026-07-22: 代理透传上游 usage 事件，诊断 cache 虚高

### 事由
调查 pi footer 上下文百分比在 40%↔20% 间反复跳变。排查后确认：
- pi 没压缩（无 compaction entry，发送量单调增）
- 讯飞 GLM-5.2 真实窗口 ≥873k token（探针 1.46M 字符全中针），不截断
- 根因是讯飞 prompt cache 在多轮递增场景下偶尔命中更大的历史缓存，把 `cacheRead` 虚报进 `totalTokens`，cache 失效后回落
- 唯一没坐实的一环：无法从 pi session jsonl 精确证明"讯飞报的 total 虚高" vs "pi 真发了那么多"

### 做了什么
给 `xunfei-proxy.js` 加 usage 透传：
- 流式：`pipeStream` 逐行解析 `data:` chunk，取最终 chunk 的 `usage` 字段
- 非流式：直接 `JSON.parse` 响应体取 `usage`
- 两条路径都发 `usage` 结构化事件到 `logs/proxy-events.jsonl`：
  `{t:"usage", id, stream, reqBytes, in, out, cached, total, finish}`
  `reqBytes` = 代理收到的请求体字节数，`in/cached/total` = 讯飞报的 token
- 下次 pi 跳变时，对比 `reqBytes`（pi 实际发了多少）vs `in/cached/total`（讯飞认了多少）即可坐实根因
- `pipeStream` 签名加了 `reqBytes` 参数

### 注意
- 只加日志，不改转发逻辑，不影响功能
- 流式 usage 在最终 chunk（`finish_reason:stop` 那条 data）里，已验证讯飞会发
- `service.ps1 install` 重启生效（改 envVars 或代码都要 install，见 2026-07-19 教训）
- 排查时 `tail -f logs/proxy-events.jsonl | grep usage` 看每轮 token 数

## 2026-07-22: pi 扩展按 session id 隔离多终端

### 事由
代理是单进程共享，所有 pi 终端的请求事件都写进同一个 `proxy-events.jsonl`，而每个 pi 终端的插件都 tail 这份文件且把**所有**事件喂进单一 Runtime——A 终端发请求，B 终端 footer 也跟着跳，分不清谁是谁的请求。

### 做了什么
利用 pi 原生的 `ctx.sessionManager.getSessionId()`（每终端/session 唯一）打通终端标识：
- **插件侧** `xf-proxy-status.ts`：注册 `before_provider_headers` 事件，给出站请求注入 `x-pi-session` 头（值 = 当前 session id）；`startup` 里 `rt.sid = ctx.sessionManager.getSessionId()`；`applyEvent` 按 sid 过滤（`start`/`fatal` 全局事件放行），footer 和 widget 的 `rawLines` 都只收本会话事件
- **代理侧** `xunfei-proxy.js`：请求入口读 `req.headers["x-pi-session"]`，登记到 `reqSidMap`（reqId → sid）；`emit` 时给已登记 reqId 的事件自动补 `src:"pi"` + `sid` 字段；请求结束 `finally` 里删除登记。全局事件（`start`/`fatal`）不带 sid

事件长这样：`{"t":"req_start",...,"src":"pi","sid":"019f87dd-..."}`

### 注意
- **插件运行路径 ≠ 编辑路径**：编辑处在 `pi-extension/xf-proxy-status.ts`，pi 实际加载全局副本 `C:\Users\lenovo\.pi\agent\extensions\xf-proxy-status.ts`。**改完必须 cp 覆盖到全局，再让用户 /reload（或重开终端），否则改动完全不生效**（详见 `pi-extension/AGENTS.md`）
- 本次首次实现时就踩了这个坑：只改编辑处、没覆盖运行处，导致头没注入、代理日志全无 `src/sid`，多终端仍同步。根因即运行路径被忽略
- `before_provider_headers` 对所有 provider 触发；给非 xf-proxy 的 provider 也注入此 header 无害（上游不读）
- 非 pi 客户端（`xf-test` 探针、curl）不带 `x-pi-session` → 事件无 `src/sid` → 不被任何终端匹配 → 不污染 footer（期望行为）
- 代理改代码需 `Restart-Service`（或 `service.ps1 install`，见 2026-07-19 教训）；插件改代码需覆盖全局 + /reload
- 验证全链路：发请求后 `cat logs/proxy-events.jsonl`，pi 的请求事件应带 `"src":"pi","sid":"..."`
