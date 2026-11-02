# Getting started / 开始使用

[中文首页](../README.md) · [English README](../README.en.md)

## 中文

先按首页步骤启动应用，再完成以下配置。

1. **添加项目资料。** 将 [example-project.json](../src/lib/geo/data/example-project.json) 复制到本地 `data/local-projects/my-project.json` 后编辑项目资料与资产，并按下方清单登记相同项目 ID。这个目录被 Git 忽略，勿在源码示例里填写真实资料。当前尚无应用内创建项目或导入材料入口。
2. **连接搜索与分析服务。** 在「设置」配置搜索服务和分析模型，或参考 [.env.example](../.env.example)。API 分析模型用于拟题、回答审核、方案生成与独立审核；ChatGPT 订阅连接可用于部分分析操作，具体见[设置说明](API/opengeo/pages/settings.md)。
3. **选择问题并搜索。** 查看已有记录和保存设置不会发起搜索。连接测试、拟题、搜索及分析可能收费；搜索费用上限不覆盖分析模型费用。启用每日计划需要本地服务持续运行，真实定时触发仍待验证。

密钥、登录状态和业务数据库保存在本地；调用服务时会向所选供应商发送必要材料。不要公开密钥或私人项目资料。

当前支持单题改进、实施登记与跟测，项目整体优化仍在开发。重新拟题与历史候选的完整合并仍待完善，已有搜索观测独立保留。[仓库选题 Skill](../skills/repository-topic-discovery/SKILL.md) 可单独使用，尚未接入应用建项目和材料导入。

需要开发细节时，查看[接口文档](API/OPENGEO-CONTRACTS.md)、[Agent 说明](../skills/README.md)和[数据存储说明](API/opengeo/storage.md)。

## English

Start the app using the README instructions, then complete the following setup.

1. **Add project material.** Copy [example-project.json](../src/lib/geo/data/example-project.json) to local `data/local-projects/my-project.json`, edit the project and assets, and register the matching project ID in the manifest below. This directory is Git-ignored; do not put private material in the source examples. In-app project creation and material import are not yet available.
2. **Connect search and analysis services.** Configure search services and analysis models in Settings, or refer to [.env.example](../.env.example). API analysis models support question drafting, answer review, proposal generation, and independent review. A ChatGPT subscription connection supports selected analysis operations; see the [settings documentation](API/opengeo/pages/settings.md).
3. **Choose a question and search.** Viewing saved records and saving settings do not start searches. Connection tests, question drafting, searches, and analysis may incur charges. The search spending cap does not cover analysis model costs. Daily schedules require the local service to keep running; a real scheduled trigger has not yet been verified.

Keys, login state, and the business database are stored locally. Service calls send necessary material to your selected providers. Do not share keys or private project information.

This release supports proposals for individual questions, implementation records, and follow-up collection. Project-wide optimization and complete merging of redrafted questions with historical candidates are still in development; existing search observations remain separately preserved. The [repository topic-discovery Skill](../skills/repository-topic-discovery/SKILL.md) is available separately and is not connected to in-app project creation or material import.

For development details, see the [API documentation](API/OPENGEO-CONTRACTS.md), [Agent guide](../skills/README.md), and [data storage documentation](API/opengeo/storage.md).

## 本地项目清单 / Local project manifest

`data/local-projects/projects.json`（示例 / example）：

```json
{
  "defaultProjectId": "example-project",
  "projects": [{ "id": "example-project", "seedFile": "my-project.json" }]
}
```

重启后读取清单；无本地清单时展示空示例。可通过 `GEO_LOCAL_PROJECTS_DIR` 指定材料目录。`DATA_DIR` 单独控制数据库根目录，迁移已有项目时保留项目 ID、默认项目和原数据库位置。

Restart to load the manifest; without one, the app uses empty examples. `GEO_LOCAL_PROJECTS_DIR` selects the materials directory. `DATA_DIR` controls databases separately. Preserve existing project IDs, the default project, and database locations during migration.
