# Getting started / 开始使用

[中文首页](../README.md) · [English README](../README.en.md)

## 中文

先按首页步骤启动应用，再完成以下配置。

1. **添加项目资料。** 编辑 [example-project.json](../src/lib/geo/data/example-project.json) 或 [example-project-two.json](../src/lib/geo/data/example-project-two.json) 中的项目资料和资产，保留结构与项目 ID。当前尚无应用内创建项目或导入材料入口；公开版不附带个人项目或搜索证据。
2. **连接搜索与分析服务。** 在「设置」配置搜索服务和分析模型，或参考 [.env.example](../.env.example)。API 分析模型用于拟题、回答审核、方案生成与独立审核；ChatGPT 订阅连接可用于部分分析操作，具体见[设置说明](API/opengeo/pages/settings.md)。
3. **选择问题并搜索。** 查看已有记录和保存设置不会发起搜索。连接测试、拟题、搜索及分析可能收费；搜索费用上限不覆盖分析模型费用。启用每日计划需要本地服务持续运行，真实定时触发仍待验证。

密钥、登录状态和业务数据库保存在本地；调用服务时会向所选供应商发送必要材料。不要公开密钥或私人项目资料。

当前支持单题改进、实施登记与跟测，项目整体优化仍在开发。重新拟题与历史候选的完整合并仍待完善，已有搜索观测独立保留。[仓库选题 Skill](../skills/repository-topic-discovery/SKILL.md) 可单独使用，尚未接入应用建项目和材料导入。

需要开发细节时，查看[接口文档](API/OPENGEO-CONTRACTS.md)、[Agent 说明](../skills/README.md)和[数据存储说明](API/opengeo/storage.md)。

## English

Start the app using the README instructions, then complete the following setup.

1. **Add project material.** Edit the project details and assets in [example-project.json](../src/lib/geo/data/example-project.json) or [example-project-two.json](../src/lib/geo/data/example-project-two.json), preserving their structure and project IDs. In-app project creation and material import are not yet available. The public release includes no personal projects or search evidence.
2. **Connect search and analysis services.** Configure search services and analysis models in Settings, or refer to [.env.example](../.env.example). API analysis models support question drafting, answer review, proposal generation, and independent review. A ChatGPT subscription connection supports selected analysis operations; see the [settings documentation](API/opengeo/pages/settings.md).
3. **Choose a question and search.** Viewing saved records and saving settings do not start searches. Connection tests, question drafting, searches, and analysis may incur charges. The search spending cap does not cover analysis model costs. Daily schedules require the local service to keep running; a real scheduled trigger has not yet been verified.

Keys, login state, and the business database are stored locally. Service calls send necessary material to your selected providers. Do not share keys or private project information.

This release supports proposals for individual questions, implementation records, and follow-up collection. Project-wide optimization and complete merging of redrafted questions with historical candidates are still in development; existing search observations remain separately preserved. The [repository topic-discovery Skill](../skills/repository-topic-discovery/SKILL.md) is available separately and is not connected to in-app project creation or material import.

For development details, see the [API documentation](API/OPENGEO-CONTRACTS.md), [Agent guide](../skills/README.md), and [data storage documentation](API/opengeo/storage.md).
