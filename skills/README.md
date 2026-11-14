# OpenGEO Skill 提示词组织约定

本目录存放各业务环节的提示词与运行时参数，通过 [agent-files.ts](../src/lib/geo/agent-files.ts) 按当前执行阶段与项目场景按需单文件加载。

## 自描述规范（零跨文件清单维护）

- **顶部 YAML 标签即索引**：每份 `.md` 提示词文件顶部自带 `--- ... ---` YAML Frontmatter，标注所属 `tab`、`scenario`、`role`、`id` 与 `title`。增删提示词即插即用，不需要手写额外页面导航表。
- **自动剥离不占 Token**：`readAgentText()` 在送入模型前会自动剥离顶部 YAML 块，仅注入正文指令。
- **参数就近保存**：各目录内的 `parameters.json` 保存 `temperature`、`maxTokens`、`maxTurns` 等运行时参数，由对应程序读取并校验。
- **按项目场景隔离**：`improvement-planning/` 下的场景文体母版按无歧义场景名分目录组织——当前已打磨 **`open-source-repo`**（开源代码仓库），后续扩展 **`ecommerce-store`**（电商店铺）、**`company-product`**（公司或产品）、**`creator-media`**（自媒体）时直接平铺新增同级目录即可。
