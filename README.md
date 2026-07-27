# xf-proxy

讯飞星辰（xunfei） API 本地代理，自定义重试策略，注册为 Windows 系统服务（nssm，开机自启 + 崩溃自动重启）。

```
客户端 → localhost:3000/v1 → xunfei-proxy(重试) → 讯飞星辰 v2 API
```

## 快速开始

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

# 项目来由
讯飞套餐量大但是根本用不完，排队太严重，加上很多agent的重试策略是指数退避，即1s，2s，4s，8s，16s，32s
这种重试策略在pvp里只会输光光，故开此简单项目作为本地重试代理
默认重试策略是0.5s一次，每10次停5s，上限50次，可通过.env进行配置

# 其他
项目带一个pi插件用于在pi agent的footer栏快速查看当前重试状态
configs文件夹是pi和opencode的讯飞模型配置，踩了一些思考强度相关的坑，你可以使用这些配置文件来简单跳过这些坑
Windows项目，但是核心文件只有xunfei-proxy.js，切换不难

人类看到这里就行了，后续请丢给ai阅读
> 安装、配置、管理命令、日志、目录结构等完整文档见 [AGENTS.md](./AGENTS.md)。

# UnLicense
Unlicense - [LICENSE](./LICENSE)