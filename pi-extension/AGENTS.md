# xf-proxy-status.ts 部署说明

## 运行路径 ≠ 编辑路径（务必先读）

本目录的 `xf-proxy-status.ts` **仅是代码编辑处**，pi 实际加载的是全局副本：

- 编辑处：`T:\xf-proxy\pi-extension\xf-proxy-status.ts`
- 运行处：`C:\Users\lenovo\.pi\agent\extensions\xf-proxy-status.ts`

**改完编辑处后，必须把文件复制覆盖到运行处，否则改动对 pi 完全不生效**（pi 根本不读本目录）。

## 改动流程（每次必走）

1. 修改本目录的 `xf-proxy-status.ts`
2. 执行覆盖：
   ```bash
   cp "T:/xf-proxy/pi-extension/xf-proxy-status.ts" "C:/Users/lenovo/.pi/agent/extensions/xf-proxy-status.ts"
   ```
3. 通知用户在 pi 终端执行 `/reload`（或重开终端），新代码才加载
4. 验证生效：grep 确认运行处已含新逻辑，例如
   ```bash
   grep -c "<新加的关键标识>" "C:/Users/lenovo/.pi/agent/extensions/xf-proxy-status.ts"
   ```

## 排查「改了没生效」时优先怀疑路径

若 pi 表现与代码不符，第一步永远是确认运行处那份的内容，不要反复改编辑处。
可用 diff 快速核对两份是否一致：
```bash
diff "C:/Users/lenovo/.pi/agent/extensions/xf-proxy-status.ts" "T:/xf-proxy/pi-extension/xf-proxy-status.ts"
```

## 历史教训

- **2026-07-22 终端隔离**：加 sid 过滤时只改了编辑处、没覆盖运行处，导致插件没注入 `x-pi-session` 头，代理日志全无 `src/sid`，多终端仍同步显示。根因即「运行路径 ≠ 编辑路径」被忽略。