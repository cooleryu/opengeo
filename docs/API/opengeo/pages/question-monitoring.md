# 问题监测

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

## 数据生产与更新审计

公开版从空示例开始；搜索执行器将新观测追加到 SQLite。本次发布未调用真实搜索或按真实时间验证每日计划。以下是已有链路的边界：

| 缺口 | 当前行为及证据 | 补齐方向 |
| --- | --- | --- |
| 重新拟题不合并当前候选 | [question-planner.ts:208](../../../../src/lib/geo/question-planner.ts#L208) 从 seed 重新起步；[store.ts:448](../../../../src/lib/geo/store.ts#L448) 只恢复 existing 旧题的选中状态。人工及上轮模型候选移出最新列表，旧 revision 仍在 SQLite，未被物理删除。 | 传入当前候选与已确认题，保存合并、保留、替代和去向，不能重新从种子重建当前库。 |
| 问题诊断不随新观测生产新版 | [research-batch-plan.ts:33](../../../../src/lib/geo/research-batch-plan.ts#L33) 初始化“本批尚未搜索”；新采集只追加观测。[ResearchPanel.tsx:1283](../../../../src/components/geo/ResearchPanel.tsx#L1283) 仍读批次内旧 diagnosis。改进任务的模型诊断存在，但未供此处消费。 | 诊断绑定 run/观测及版本；新搜索后标记待更新，产出新版诊断、承接与缺口评估，保留历史版本。 |
| 消费端浏览器接入 | [浏览器逐题入库](../browser-observations.md) 已提供原文保存、自动分析和概览更新接口；浏览器采集器另行运行，不是页面搜索按钮或定时任务。 | 不能把 ChatGPT API 当作消费端网页；真实浏览器适配的验证范围见采集文档。 |
| 部分页面仍有独立刷新依赖 | 搜索页有请求结束刷新与计划轮询；概览已通过可见时的小版本检查更新。指定历史批次及独立竞品页面仍有各自的读取依赖。 | 边界见[共享刷新审计](../shared.md#数据生产与更新审计)。 |

当前工作台仅支持 **ChatGPT** 与 **Google**（浏览器采集 `/api/geo/browser-collect` 或手动导入），旧版搜索 API 与每日 API 自动跟踪计划已下线；时间统一按 UTC，费用字段统一使用 USD（`$`）。题单人工确认、保留旧问法、原文文件与 SQLite 分存均不是自动化缺陷。

[题目和题单的编辑](#题目和题单的编辑) · [读取列表、详情、图表与原文](#读取列表详情图表与原文) · [研究运行与停止接口](#研究运行与停止接口) · [源码与落库](#源码与落库) · [回答里的人工事实核查](#回答里的人工事实核查)

唯一问题列表入口为 `view=question-plan`。旧 `view=questions` 链接会转入新版列表，保留筛选、语言、平台及具体回答定位；每题的历史回答仍在详情中查看。页面中的“搜索问题”输入框仅过滤当前问题清单。

## 题目和题单的编辑

AI 审核分别返回争取价值与当前承接程度，缺材料不自动等于排除；身份约束、来源引用和历史题保护仍由程序检查。详见 [出题 Skill](../../../../skills/question-planning/SKILL.md)。

所有操作均为 `POST /api/geo`，通用请求含 `projectId, action, planId, revision`。`planId/revision` 必须取当前 `GeoState.questionPlan`，成功后用返回的新 `GeoState` 替换页面状态；旧 revision 返回 409，刷新后让用户重新决定，不自动覆盖。

| action / 操作 | 附加请求字段 | 后端处理 / 前端接收 |
| --- | --- | --- |
| `save_question` 添加/改题 | 必填 `query, category, intent, rationale, expectedResult, assetIds`；可选 `queryEn, candidateId, sourceQuestionId` | 保存人工候选，新版本保留来源关系，默认待审、不选中；不调用模型、不搜索 |
| `review_question` 人工审核 | `candidateId, decision:include\|explore\|exclude, reason` | 保存判断；排除则取消选择，审核通过也不自动选中 |
| `select_question` 选择/移出 | `candidateId, selected:boolean` | 最多 8 个独立问题；待审、排除或已被新版替代的题不能选入 |
| `confirm_questions` 确认题单 | 无额外字段 | 事务内保存 ready 题单及不可变研究批次；不联网。返回 `questionPlan` 和 `latestResearch` |
| `generate_questions` AI 拟题与审核 | `positioning` 项目定位，非空、最多 1000 字符 | 调用生成/审核模型，可能收费；返回 draft 题单。不是读取现成候选的接口 |

### 生成推荐问题的失败续接

`start_question_generation` 启动后台准备并立即返回 `questionGeneration`；兼容的 `generate_questions` 等待同一任务结束，可推送进度。两者都接收当前 `planId/revision`、`positioning` 和可选 `requestId`。页面读取 `GeoState.questionGeneration` 展示进度，读取本身不调用模型。

- 方向、各方向候选、独立审核及最终覆盖审核的中间成果保存在项目 SQLite 的 `geo_question_generation_jobs`；题单仍按 revision 存在 `geo_question_plans`，旧记录不删除。
- 同一次请求重发沿用原 `requestId`，返回已有任务；用户明确点击失败重试时使用新 `requestId`。同项目已有相同条件的任务运行中时复用它，不重复启动。
- 上一任务失败或因服务重启中断后，重试核对项目资料、定位和题单版本；兼容时把已保存成果交回原生成器，只请求缺失步骤。新任务也保留这些成果，再次中断不会丢失之前的进度。
- 修改了资料、定位或题单后不复用过期成果；上一轮覆盖审核未完成而已保存的 draft revision 仍可续接，之后的人工修改会使旧成果失效。旧任务没有中间成果时无法恢复那部分；已保存成果不合法时明确报错，不悄悄从头收费重跑。
- API 只向页面返回阶段及成果摘要，不接受客户端提供中间成果。没有收到并保存的模型响应仍需在明确重试后重新请求；无法保证供应商未对上次请求计费。

`save_question`：`query` 3–300 字符；英文可空，非空至少 3 字符、最多 300；`intent/expectedResult` 5–600；`rationale` 5–800；`assetIds` 必须是数组、最多 8 个不同的当前项目材料 ID。`candidateId` 表示编辑候选；`sourceQuestionId` 表示从已有题调整，不能换掉既有来源。人工审核 `reason` 为 5–900 字符。

存储类别仍为 `brand|positioning|problem|content|comparison|boundary`；列表简化显示“品牌问题/需求问题”不改变原字段。`QuestionCandidate` 的核心返回字段：`id, query, queryEn?, category, origin, intent, rationale, expectedResult, assetIds, evidence[], review, selected`；版本关系为 `sourceQuestionId/sourceResearchBatchId/supersedesCandidateId/supersededByCandidateId`。`demandStatus=unverified` 不能解释成已验证真实需求。

确认后的批次 ID 为 `${plan.id}:revision:${plan.revision}`，冻结中英问法、类别、依据和题单快照；新批次不继承旧题的观测。题单 `ready` 和研究题 `decision=search_now` 含义不同，不能混用为“已搜索”。没有英文问法时，不自动翻译或拿中文结果填英文。

## 读取列表、详情、图表与原文

**`GET /api/geo/research`**，返回 `{batch, runs, providers}`；带 `question` 时再返回 `{question, detail}`。`batch` 没有记录时可为 `null`。

| query | 默认 / 规则 | 作用 |
| --- | --- | --- |
| `project` | 默认 `example-project`；前端总是显式传 | 项目隔离 |
| `batch` | 可选，默认当前项目最新入库批次 | 读取旧批次时必传；未知批次 404 |
| `question` | 可选 | 指定题目详情；可来自核心或候补；未知题目 404 |
| `language` | `zh`，只允许 `zh/en` | 详情使用的问法及观测语言 |
| `engine` | `all`；或 `chatgpt/google` | 详情平台范围 |
| `history` | `0`；或 `1` | 同题同语言同平台的最新一条 / 全部已存观测 |

这些已知参数重复或显式传空字符串返回 400。**`language/engine/history` 约束 `detail`，不裁剪返回的整个 `batch`。** 列表仍通过前端 `getResearchRows` 等函数做过滤；目前没有独立的分页列表 API。

| 返回对象 | 前端需要的字段 |
| --- | --- |
| `ResearchBatch` | `id, projectId, date, updatedAt?, questions[], deferredQuestions[]`；以及产品/贡献摘要、报告路径、可选 `questionPlan` 快照；响应附带 `answerAudits/overviewMetrics`，定义见[概览](overview.md#返回字段与统计口径) |
| `ResearchQuestion` | `id, candidateId?, category?, zh, en, decision, valueReason, evidenceBasis, answerability, gaps[], decisionReason, observations[], diagnosis` |
| `ResearchObservation` | `id?, runId?, engine, entryType?, language, query, recordedAt, collectedAt?, status, summary, conditions, sources[], evidencePath, answerPath?, overviewStatus?` |
| `ResearchSource` | `title, url, kind:official\|other\|self_submission\|mirror, position?` |
| `providers[]` | `id, label, configured, missing[], model, costNote`；配置就绪状态，不含 Key |

观测类型 `entryType` 区分 `web_answer/web_search/api_answer/api_search`。`diagnosis={observed,hypothesis,nextStep}` 是已保存诊断；每次新搜索会追加观测并处理该条回答的提及/引用审核，但**不会顺便重新运行改进任务的 AI 诊断**。审核的证据、字段及语义校验见[概览](overview.md#回答审核的生产与校验)；网页搜索不进入 AI 提及/引用指标。

**图表专用响应：`QuestionDetail`（`version:1`）**

```ts
{
  version: 1,
  projectId: string, batchId: string, questionId: string,
  language: 'zh' | 'en', title: string, mode: 'latest' | 'history',
  platforms: QuestionDetailPlatform[]
}
```

| `platforms[]` 字段 | 后端提供 / 前端处理 |
| --- | --- |
| `recordKey, observationIndex` | 原记录定位键和数组下标；未测的 index 为 null。用于图表选中与来源定位，前端不重排后再生成 ID |
| `engine, label, entryLabel, recordedAt` | 平台、入口类型和记录时间；日期可为历史记录原有描述，不保证都是完整时间戳 |
| `status` | `found/not_observed/unmeasured`；分别表示找到、本次未见、未测 |
| `officialCount, otherCount, totalSources, otherSourcesCount` | 已测返回数值；未测/不可确认返回 null，不能转成 0 |
| `sources[]` | 去重后的来源；Google 正常网页计数仅包括有正数 position 的条目，其他附带来源放入 `otherSourcesCount` |
| `summary, query, conditions, answerPath?, evidencePath?` | 展示摘要、原问法、条件，以及完整原文的读取引用 |

前端 `QuestionDetailVisual` 校验 `version/projectId/batchId/questionId/language`，按返回的数字画来源构成；不解析摘要里的数字，不把来源数当“用户数/回答率”。完整回答用 [共享原文接口](../shared.md#原回答与证据文件) 读取，不能直接把文件路径当公网 URL。

## 研究运行与停止接口

旧版搜索 API 采集已下线，请使用应用内或命令行 Google / ChatGPT 浏览器采集（`POST /api/geo/browser-collect`）；每日 API 自动搜索计划路由 `/api/geo/research/tracking` 已移除。

`POST /api/geo/research` 当前仅保留：
- **`{ action: "stop", projectId, runId }` → `{ run }`**：针对历史兼容运行的幂等停止接口；按项目隔离并持久化 `stopRequestedAt`，当前项目不存在的 run 返回 `404`。
- 其他搜索 API 启动请求一律返回 **HTTP 410**，提示改用 `/api/geo/browser-collect`。

历史研究运行记录 `ResearchRunRecord` 仍可在只读列表接口中读取，关键字段包括 `id, projectId, batchId, provider ('chatgpt' | 'google'), language, questions[], status ('running'|'completed'|'partial'|'failed'|'interrupted'), startedAt, updatedAt, completedAt?, completedCount?, error?, stopRequestedAt?, spent, confirmedSpentUsd?, reservedUsd?, entryType?, evidencePath?, scheduleId?, taskId?`，金额字段统一以 USD 计价。

## 源码与落库

- 页面：[QuestionManagementPanel](../../../../src/components/geo/QuestionManagementPanel.tsx)、[ResearchPanel](../../../../src/components/geo/ResearchPanel.tsx)、[QuestionDetailVisual](../../../../src/components/geo/QuestionDetailVisual.tsx)。
- 路由：[research](../../../../src/app/api/geo/research/route.ts)、[browser-collect](../../../../src/app/api/geo/browser-collect/route.ts)；浏览器采集库：[browser-collection](../../../../src/lib/geo/browser-collection.ts)。
- 类型：[question-types](../../../../src/lib/geo/question-types.ts)、[research-types](../../../../src/lib/geo/research-types.ts)、[question-detail-types](../../../../src/lib/geo/question-detail-types.ts)、[research-store 的 ResearchRunRecord](../../../../src/lib/geo/research-store.ts)。
- 题单修订存 `geo_question_plans`；确认批次存 `geo_research_batches`；追加观测存 `geo_research_observations`；执行记录存 `geo_research_runs`。完整响应经已有原文文件引用读取；首次初始化会导入仓库历史种子，之后不从历史种子或失效平台覆盖当前库。

## 回答里的人工事实核查

`POST /api/geo`，`{action:"save_claim_review",projectId,review}`，不要求 taskId。review 必填 `projectId,batchId,questionId,observationIndex,engine,language,quote,fact,scope,evidenceUrl,conclusion`。observationIndex 必须为非负整数；review.projectId ≤128字符，batchId/questionId ≤200字符。其中结论为 `supported/contradicted/uncertain`；quote ≤8000、fact ≤6000、scope ≤4000 字符，evidenceUrl 为无凭据的 HTTP(S) URL、≤2048 字符。

后台要求当前项目最新批次、观测序号/平台/语言匹配，且是有完整 answerPath 的 ChatGPT 记录；quote 必须出现在已保存原文中，摘要不能代替。保存到 `geo_claim_reviews`，返回完整 GeoState，其中 claimReviews 更新；记录含 id、reviewedAt、reviewer=user。只记录人工结论，不访问依据链接、不调用事实核查模型。

源码：[claim-review](../../../../src/lib/geo/claim-review.ts)、[ClaimReviewPanel](../../../../src/components/geo/ClaimReviewPanel.tsx)。
