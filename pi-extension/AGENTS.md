# xf-proxy-status.ts 部署说明

> 本文件被多台机器从 GitHub 共用。**不要在示例里写死任何机器的绝对路径**（盘符 / 用户名 / 仓库根）。
> 下方一律用占位符：`<repo>` = 本机 clone 的仓库根；`~` = 当前用户主目录（`%USERPROFILE%` / `$HOME`）。

## 运行路径 ≠ 编辑路径（务必先读）

仓库内的 `xf-proxy-status.ts` **仅是代码编辑处**，pi 实际加载的是全局副本：

- 编辑处：`<repo>/pi-extension/xf-proxy-status.ts`（仓库根随机器而异，可能 `D:\`、`T:\` …）
- 运行处：`~/.pi/agent/extensions/xf-proxy-status.ts`（跨机器统一，在用户主目录下）

**改完编辑处后，必须把文件复制覆盖到运行处，否则改动对 pi 完全不生效**（pi 根本不读本目录）。

## 改动流程（每次必走）

1. 修改 `<repo>/pi-extension/xf-proxy-status.ts`
2. 覆盖到运行处（选一种）：
   ```bash
   # bash / git-bash（~ 自动展开）
   cp "<repo>/pi-extension/xf-proxy-status.ts" ~/.pi/agent/extensions/xf-proxy-status.ts
   ```
   ```powershell
   # PowerShell
   Copy-Item "<repo>\pi-extension\xf-proxy-status.ts" "$env:USERPROFILE\.pi\agent\extensions\xf-proxy-status.ts" -Force
   ```
   > `<repo>` 用本机实际仓库根替换；不要把某台机器的绝对路径提交进文档。
3. 通知用户在 pi 终端执行 `/reload`（或重开终端），新代码才加载
4. 验证运行处已含新逻辑：
   ```bash
   grep -c "<新加的关键标识>" ~/.pi/agent/extensions/xf-proxy-status.ts
   ```

## 排查「改了没生效」时优先怀疑路径

若 pi 表现与代码不符，第一步永远是确认运行处那份的内容，不要反复改编辑处。
用 diff 快速核对两份是否一致：
```bash
diff ~/.pi/agent/extensions/xf-proxy-status.ts "<repo>/pi-extension/xf-proxy-status.ts"
```

## 日志路径：跟随代理，不要硬编码

插件读 `proxy-events.jsonl` 的路径，**默认从代理 `/health` 响应的 `logPath` 字段自动获取**（代理是日志路径的唯一权威：它用 `LOG_DIR` env，留空回退到 `<脚本目录>/logs`）。
因此代理换机器 / 改 `LOG_DIR` / 换盘符，插件都自动跟随，**代码里不应出现任何硬编码的绝对日志路径**。

- 可选 override：若设了环境变量 `XF_PROXY_LOG`，插件优先用它且不再跟随 `/health`（仅调试 / 特殊场景用）。
- 代理 `/health` 形如：`{"status":"ok","logPath":"<绝对路径>/proxy-events.jsonl"}`。

## 历史教训（按时间倒序）

- **2026-07-23 日志路径硬编码导致插件「没生效」**：代码把 `XF_PROXY_LOG` 的回退值写死成某一台机器的绝对路径（`<某机器绝对路径>/logs/proxy-events.jsonl`），在仓库位于其他盘符的机器上 `LogTailer.statSync` 永久失败、读不到任何事件，状态恒为 `—`。
  根因：**跨机器共用的代码里硬编码了本机绝对路径**。修复 = 改由代理 `/health` 自报 `logPath`、插件去问（方案 C），彻底消除硬编码。
  通用规则：本目录代码与文档一律不得出现某台机器的盘符 / 用户名 / 绝对仓库根。
- **2026-07-22 终端隔离**：加 sid 过滤时只改了编辑处、没覆盖运行处，导致插件没注入 `x-pi-session` 头，代理日志全无 `src/sid`，多终端仍同步显示。根因即「运行路径 ≠ 编辑路径」被忽略。
