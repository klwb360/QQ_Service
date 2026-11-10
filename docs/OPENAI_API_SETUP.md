# 给 QQ_Service 配置专用 OpenAI API

[返回首页](../README.md) · [使用指南](USAGE.md)

v0.7.0 仅通过 API 接入模型，不再安装或登录 Codex。机器人专用 API 指的是独立的 **Project＋API Key**，无需再注册一个 ChatGPT 账号。

## 1. 先激活可领取的额度

用订阅对应的邮箱登录 ChatGPT，在 **设置 → Billing → API credits** 按提示绑定自己拥有的 API 组织；激活后到 [API Platform](https://platform.openai.com/) 的 Billing 核对到账组织、余额和到期日。

符合条件的付费 Pro／Business 订阅可领取；需符合已付费满 7 天、同邮箱及拥有接收组织等资格。首次额度按剩余周期折算，未用完部分在计费周期结束时过期。是否符合资格、具体金额以官方页面和实际到账为准。[官方领取说明](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

## 2. 创建机器人项目和 Key

1. 在 API Platform 切到**刚收到额度的组织**，创建名为 `QQ_Service` 的项目。
2. 在项目 Members 中新建服务账号，例如 `qq-service-bot`，为它生成 Key；也可先创建只属于该项目的个人 Key。
3. 保存一次性显示的 Key，随后在项目 API Keys 中收窄权限：保留模型请求权限，需允许本应用使用的 `POST /v1/chat/completions`。不需要管理组织、文件或助手的权限，也不要给应用 Admin API Key。

服务账号适合持续运行的机器人，项目 Key 将资源和用量归到该项目。服务账号 Key 创建后可能默认权限较宽，需在 API Keys 中再编辑。[官方项目与 Key 说明](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)

## 3. 设置模型、限额与提醒

在项目 **Limits** 中只启用准备使用的模型，设置请求速率、每月预算和提醒。**单设预算或提醒不会停止请求**；若页面提供 **Enforce a hard limit**，可开启实际限额，但执行可能有延迟，不能保证绝不超出。先不启用自动充值，另在 QQ_Service 设置合适的自主聊天调用预算。[官方用量限制说明](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform)

## 4. 填入 QQ_Service

在「账号控制 → 账号与 AI」选择 **OpenAI API**：

| 参数 | 填写内容 |
| --- | --- |
| API 基础地址 | `https://api.openai.com/v1` |
| 模型名称 | 项目有权限、支持 Chat Completions 的实际模型 ID，不能填写套餐名 |
| API Key | 上一步创建的机器人项目 Key |

如需插件工具调用，所选模型还需支持 function calling。把 Key 填在应用的密钥栏，不写进配置文件、群消息或仓库。

点击测试连接，保存并应用，再到「选定群与消息权限」确认范围并重新释放账号权限。测试会产生真实 API 请求；Key 配好不等于已经允许 QQ 自动发言。

## 遇到错误时

| 现象 | 先检查 |
| --- | --- |
| Key 无效或权限不足 | 是否复制完整、是否已撤销、是否允许模型请求 |
| 模型或参数不支持 | 模型 ID、项目 Model usage 与 Chat Completions 兼容性 |
| 额度不足 | Key 所属组织是否就是领取额度的组织，额度是否已到期 |
| 速率受限 | 项目及模型的请求／Token 限制；有余额仍可能触发速率限制 |
| 测试通过但 QQ 不回复 | 实际 QQ 登录、聊天开关、群读写范围和最终账号授权 |

API 与 ChatGPT 仍各自管理计费。赠送额度用完后，如组织中还有购买额度，请求可能继续消耗购买额度；不要把赠送额度当作所有费用的自动止付线。[官方额度与计费说明](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
