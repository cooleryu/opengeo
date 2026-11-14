---
name: question-planning
description: 为 OpenGEO 问题监测生成候选问题，或对一个已有候选进行双判断复评。仅由明确页面操作发起，不执行搜索或发布。
---

# 问题监测：候选出题与审核

对应问题监测中的 AI 出题，调用入口是 `src/lib/geo/question-planner.ts` 的 `generateQuestionPlan`。使用现有分析模型设置：启用 ChatGPT 订阅时沿用订阅模型与思考强度，否则使用 API 分析模型；失败不静默切换。

先从实际能力与已有贡献展开陌生用户的目标、完整行动过程和自然需求，记录有依据的项目选择价值，再聚合成最多 3 个并行工作方向。需求数量不受并发方向数限制，不按功能列 FAQ，也不预设用户已经选择某种方法或监测工具。每方向最多生成 4 个候选，再按每批最多 4 题并行独立审核。随后单独审核整组的需求覆盖、重复与取舍，选择最多 8 题；不能把单题高优先级排序当成整组通过。

整组审核先独立检查需求地图本身是否漏掉重要用户目标，再判断已有需求的覆盖。已有 high+missing 或新发现的重要遗漏合并处理，最多补一批 4 题（同时受剩余候选额度限制），独立审题后对全部候选重做整组审核。仍有重要缺口、或复核又发现新遗漏时保留未完成状态，不再增加调用轮次；有具体理由暂缓的 deferred 单独保留，不靠阶段配额补齐。各阶段通过校验后保存完整中间成果。原文摘录检查失败时，该批最多一次定向摘录修正；任一调用或校验失败不返回完整题单，中间成果不能当作可搜索结果。

单题 AI 复评入口是同文件的 `reviewQuestionCandidate(seed, plan, candidateId)`，调用一次审核模型，必要时最多一次定向摘录修正，不重新拟题。审核只收到当前问题和必要项目材料，不收到旧结论、其他题的审核、选中状态或历史搜索结果。只更新该题的审核与双判断；仅排除时取消该题选择，其他题和问法保留。复评后删除已失效的原整组审核结论，不自动重新做整组覆盖审核。版本保存由调用方负责，不自动确认题单或更新当前搜索批次。

输入是项目身份与定位、已导入材料（含公开状态、原文摘录和截断标记）以及历史题原文。单题独立审核不接收生成理由、方向规划、其他审核或选择状态。整组审核另看需求、选择价值、候选问法与单题结论，不看生成理由。输出保留全部历史题、新候选、逐题证据与判断，以及整组最终推荐和未覆盖或暂缓需求；模型不接收历史命中、排名或引擎结果。

## 文件与调用顺序

1. [common.md](common.md)：各阶段共用的需求推导、双判断与证据要求。
2. [directions.md](directions.md)：先展开 `needs` 与有依据的 `selectionAdvantages`，再用 `needIds` 聚合 `directions`，输出短摘要。
3. [propose.md](propose.md)：各方向并行生成；`{{common}}` 为共用规则，`{{maxNewCandidates}}` 为该批候选上限。补题复用此提示，新增 `missingNeeds`、`previousQuestions`、`refinementRound: 1`，只补缺口。
4. [review.md](review.md)：各批并行独立审核，逐项返回候选 ID、双判断、结论与推荐优先级；补题同样审核。
5. [set-review.md](set-review.md)：独立检查需求地图及整组，返回 `selectedIds`、输入需求的 `coverage`、实质 `duplicates`、最多 3 个 `missingAdditionalNeeds` 与简短 `reason`。新增需求沿用 needs 结构、使用新 ID 且 importance=high，不在同次 coverage 重复；程序并入地图，首轮纳入同一次补题，复核新遗漏保留为未完成。初始最多 16 个需求，两次组级审核各最多补记 3 个，最终最多 22 个。仅最终选中、单题 include、状态 reviewed 且双判断完整的问题能算覆盖；缺评估的历史题只保留，关键词不算覆盖。
6. [parameters.json](parameters.json)：原有温度、输出 token 上限、完整业务输入字节预算、材料预算与候选上限；新增整组审核沿用 `review` 参数，补题沿用 `propose` 参数。
7. [repair-evidence.md](repair-evidence.md)：仅在原文检查失败时读取，传入失败问题、摘录位置及已提供片段。只替换对应摘录，不删除依据、改题或改判断；修正后重做全部严格校验，再失败就停止。修正遵守原输入预算，不读取先前被截断的正文。

本说明用于定位文件，不会作为系统提示发送给模型。实际系统提示仅由共用规则与对应阶段提示组合。人工整理的初始题与历史题生成逻辑仍在原代码中。

## 参数口径

- `maxNewCandidates`：每份候选题单允许新增的非手工问题数量（仍为 18）；生成提示、返回校验和保存校验共用此值。首轮最多 3 个方向各 4 题，必要时最多补 4 题，均受总上限限制，不凑数。候选上限不同于本批最多 8 个独立核心问题。
- `materials.maxTotalCharacters` / `maxCharactersPerAsset`：材料正文合计与单篇的截取限制；沿用 JavaScript 字符串长度口径，不是 UTF-8 字节或 token。
- `maxInputBytes`：系统提示加用户 JSON 的 UTF-8 字节上限，最多 48 KiB。材料正文同时受此预算限制并标明截断；必要元数据已超限时在调用前失败，不静默删除问题或依据。此值不宣称是模型供应商计费 token 或服务端包装长度。
- `subscriptionTimeoutMs`：仅本角色使用 ChatGPT 订阅时，每次模型请求的超时时间，目前为 20 分钟；不改变 API 请求、全局默认或所选模型与思考强度。
- `planning`：需求展开与方向整理的温度和较小输出 token 上限；新增字段仍用短语和短句，不扩大预算。
- `propose`：生成阶段的温度和输出 token 上限。
- `review`：单题与整组审核的温度和输出 token 上限。

具体生效值以 [parameters.json](parameters.json) 为准。

新审核在 review 顶层返回 `priority=high/medium/low`，作为整组取舍的参考；`reason` 简述判断依据。`assessment.worthPursuing/currentSupport/evidence/gaps` 分别记录争取价值、当前承接、来源原文与缺口。旧记录可缺少 priority 或 assessment，由程序兼容，缺失不代表已完成对应判断。材料缺口仅作为待核查信息，不再自动排除；身份约束、虚构摘录、来源关联和历史题保护继续由 `question-planner.ts` 校验。模型、接入地址及密钥沿用应用设置，不放在这里。

整组结果保存为 `plan.coverageReview`，包括需求、选择价值、最终推荐与覆盖结论、`status=complete/incomplete` 和 `refinementRounds`。complete 表示没有尚未处理的重要需求缺口，不代表每个阶段都必须有题、更不代表真实搜索效果。`deferred` 必须保留具体取舍；单题优先级只是组级选择的输入。

供应商结构兼容仅允许一种已观测差异：`assessment.evidence` 完全缺失、同一证据数组位于 `assessment.currentSupport.evidence`。供应商收到可表示为 JSON Schema 的严格二选一结构，返回后无损移动该数组，再按标准结构及全部原文、数量、语义约束校验。两处同时有 evidence、两处都缺失或其他未知字段仍失败；结构错误不触发摘录修正，不补证据、不合并、不截断。
