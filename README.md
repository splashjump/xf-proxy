# xf-proxy

讯飞星辰（xunfei） API 本地代理，自定义重试策略，注册为 Windows 系统服务（nssm，开机自启 + 崩溃自动重启）。

```
客户端 → localhost:3000/v1 → xunfei-proxy(重试) → 讯飞星辰 v2 API
```

# 项目来由
- 讯飞套餐量大但根本用不完，排队太严重，加上很多 agent 的重试策略是指数退避（1s, 2s, 4s, 8s, 16s, 32s），在 pvp 里只会输光光
- 故开此简单项目作为本地重试代理
- 默认重试策略：0.5s 一次，每 10 次停 5s，上限 50 次，可通过 `.env` 配置

# 其他
- 带 pi 扩展，在 pi agent 的 footer 栏快速查看当前重试状态
- `configs/` 是 pi 和 opencode 的讯飞模型配置，踩了一些思考强度相关的坑，可用这些配置简单跳过
- Windows 项目，但核心文件只有 `xunfei-proxy.js`，切换不难

人类看到这里就行了，后续请丢给ai阅读

## 快速开始（如果你非要自己动手的话）

```powershell
# 1. 装 Node.js ≥ 18（winget install OpenJS.NodeJS.LTS）
# 2. 复制配置并填入讯飞 API Key
Copy-Item .env.example .env
notepad .env   # 填 XFYUN_API_KEY
# 3. 安装服务（管理员；或双击 script\install-proxy.bat）
.\service.ps1 install
# 4. 验证
Invoke-RestMethod http://127.0.0.1:3000/health   # → {"status":"ok"}
```
> 安装、配置、管理命令、日志、目录结构等完整文档见 [AGENTS.md](./AGENTS.md)。

# UnLicense
Unlicense - [LICENSE](./LICENSE)