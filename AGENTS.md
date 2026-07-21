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
- 扩展已转为**全局**：`~/.pi/agent/extensions/xf-proxy-status.ts`，所有项目都能用；默认日志路径硬编码 `D:/xf-proxy/logs/proxy-events.jsonl`，可通过 `XF_PROXY_LOG` 环境变量覆盖
- 冷却时长 2026-07-22 从 10s 调为 5s（代码默认 + `service.ps1` envVars 同改）
