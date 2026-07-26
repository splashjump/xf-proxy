# configs/

对接本仓库 `xunfei-proxy.js` 代理的**客户端**配置模板。新设备部署时拷贝到对应运行路径即可。

## 文件

| 文件 | 客户端 | 运行路径 |
|------|--------|---------|
| `pi-models.json` | pi | `C:\Users\<user>\.pi\agent\models.json` |
| `opencode.jsonc` | opencode | `C:\Users\<user>\.config\opencode\opencode.jsonc` |

两者内容等价（同一组模型 / 思考档位），仅各客户端要求的格式不同。

## 方法

1. 拷贝对应文件到运行路径
2. 重启客户端或执行 `/reload` 让配置生效

讯飞真实 API Key 在代理 `.env`（见根 `.env.example`），不在这些客户端配置里——客户端配的 `apiKey` 固定为 `"local-proxy"` 占位，代理不校验 incoming key、直接覆盖成讯飞真实 Key。

## 与代理的关系

这些只定义**客户端发什么**。思考参数（`reasoning_effort` / `enable_thinking`）的注入与字段转换由代理 `injectThinking()` 统一处理，见根 `AGENTS.md`「思考参数注入」条目。代理侧无需随客户端配置改动而改动。
