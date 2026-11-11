# 模型预设与温度参数

模型输入框提供按厂商分类的常用模型建议，也允许直接输入服务商提供的完整模型 ID。预设是输入辅助，不代表当前 API Key 已开通对应模型；选择预设不会自动测试、调用模型或切换计费通道。已有账号的模型名称保持原值。

2026-11-11 核对的预设：

| 厂商 | 模型 ID |
| --- | --- |
| DeepSeek | `deepseek-flash`、`deepseek-v4-pro` |
| OpenAI | `gpt-4.1`、`gpt-4.1-mini`、`gpt-4o`、`gpt-4o-mini` |
| 阿里云百炼 | `qwen-plus`、`qwen-turbo`、`qwen-max` |
| 智谱 | `glm-5.3`、`glm-5.3-flash`、`glm-4.7` |
| Kimi | `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3` |
| 硅基流动 | `deepseek-ai/DeepSeek-V3.2`、`Pro/deepseek-ai/DeepSeek-V3.2`、`Qwen/Qwen3.6-27B` |
| 自定义兼容接口 | 直接填写，不猜测其支持的模型 |

新账号的 DeepSeek 默认使用 `deepseek-flash`；旧配置中明确填写的值不会自动改写。模型上下线和账号权限可能变化，请以厂商控制台为准。

Temperature 在界面中显示为「回答随机性（温度）」。较低时回答通常更集中、稳定，较高时表达更多样；取值范围和是否生效由具体模型决定。DeepSeek 的思考模式会忽略该值。

Kimi 官方的上述 K3 预设要求温度固定为1。本程序向 `api.moonshot.cn` / `api.moonshot.ai` 调用这三种模型时省略 `temperature`，使用服务默认值，避免默认0.7导致接口拒绝。用户保存的温度仍保留，切换到其他模型或自定义接口时照常使用。

核对来源：

- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) · [温度参数](https://api-docs.deepseek.com/api/create-chat-completion/)
- [OpenAI 模型](https://developers.openai.com/api/docs/models) · [停用公告](https://developers.openai.com/api/docs/deprecations)
- [百炼模型](https://help.aliyun.com/en/model-studio/models)
- [智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)
- [Kimi 模型参数](https://platform.kimi.com/docs/api/models-overview)
- [硅基流动文本生成](https://docs.siliconflow.cn/docs/userguide/capabilities/text-generation) · [模型调整公告](https://docs.siliconflow.cn/docs/release-notes/overview)

## 账号配置操作栏

首次配置未完成时只显示当前步骤的操作，不显示独立保存栏。成功启动账号后，记住这个 QQ 已完成首次配置，后续使用统一的最终保存、应用栏；应用回到只读时，启动账号按钮也放在同一栏。离线不会退回首次配置模式。更换为未配置过的 QQ 时重新显示步骤操作。此标记仅影响界面，不授予读取、发送或工具权限。
