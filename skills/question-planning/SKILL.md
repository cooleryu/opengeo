---
name: question-planning
description: 为 OpenGEO 问题监测生成候选问题，或对一个已有候选进行双判断复评。仅由明确页面操作发起，不执行搜索或发布。
---

# 问题监测：候选出题与审核

对应问题监测中的 AI 出题，调用入口是 `src/lib/geo/question-planner.ts` 的 `generateQuestionPlan`。使用现有分析模型设置；出题与审核各调用一次，审核收到独立上下文。

单题 AI 复评入口是同文件的 `reviewQuestionCandidate(seed, plan, candidateId)`，只调用一次审核模型，不重新拟题。审核只收到当前问题和必要项目材料，不收到旧结论、其他题的审核、选中状态或历史搜索结果。只更新该题的审核与双判断；仅排除时取消该题选择，其他题和问法保留。版本保存由调用方负责，不自动确认题单或更新当前搜索批次。

输入是项目身份与定位、已导入材料（含公开状态、原文摘录和截断标记）以及历史题原文。输出是包含全部历史题及新候选的题单；每个候选附意图、关联材料与原文证据、预期结果、审核结论和默认选择状态。模型不接收历史命中、排名或引擎结果。

## 文件与调用顺序

1. [common.md](common.md)：两阶段共用的原有规则。
2. [propose.md](propose.md)：候选生成提示；`{{common}}` 替换为共用规则，`{{maxNewCandidates}}` 替换为参数中的候选上限。
3. [review.md](review.md)：独立审核提示；`{{common}}` 替换为共用规则，逐项返回候选 ID 与审核结论。
4. [parameters.json](parameters.json)：两阶段的 `temperature`、`maxTokens`、完整业务输入字节预算、材料字符预算与新增候选上限。程序实际读取并校验这些参数。

本说明用于定位文件，不会作为系统提示发送给模型。实际系统提示仅由共用规则与对应阶段提示组合。人工整理的初始题与历史题生成逻辑仍在原代码中。

## 参数口径

- `maxNewCandidates`：每份候选题单允许新增的非手工问题数量；生成提示、返回校验和保存校验共用此值。这是候选上限，与每批最多 8 个独立核心问题的选择规则不同。
- `materials.maxTotalCharacters` / `maxCharactersPerAsset`：材料正文合计与单篇的截取限制；沿用 JavaScript 字符串长度口径，不是 UTF-8 字节或 token。
- `maxInputBytes`：系统提示加用户 JSON 的 UTF-8 字节上限，最多 48 KiB。材料正文同时受此预算限制并标明截断；必要元数据已超限时在调用前失败，不静默删除问题或依据。此值不宣称是模型供应商计费 token 或服务端包装长度。
- `propose`：生成阶段的温度和输出 token 上限。
- `review`：审核阶段的温度和输出 token 上限。

具体生效值以 [parameters.json](parameters.json) 为准。

审核返回 `assessment.worthPursuing/currentSupport/evidence/gaps`，分别记录争取价值、当前承接、来源原文与缺口。旧记录可缺少 assessment，缺失不代表已完成双判断。材料缺口仅作为待核查信息，不再自动排除；身份约束、虚构摘录、来源关联和历史题保护继续由 `question-planner.ts` 校验。模型、接入地址及密钥沿用应用设置，不放在这里。

供应商结构兼容仅允许一种已观测差异：`assessment.evidence` 完全缺失、同一证据数组位于 `assessment.currentSupport.evidence`。供应商收到可表示为 JSON Schema 的严格二选一结构，返回后无损移动该数组，再按标准结构及全部原文、数量、语义约束校验。两处同时有 evidence、两处都缺失或其他未知字段仍失败；不补证据、不合并、不截断、不增加模型重试。
