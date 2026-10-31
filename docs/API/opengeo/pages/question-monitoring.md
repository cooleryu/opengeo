# 问题监测

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

## 数据生产与更新审计

公开版从空示例开始；搜索执行器将新观测追加到 SQLite。本次发布未调用真实搜索或按真实时间验证每日计划。以下是已有链路的边界：

| 缺口 | 当前行为及证据 | 补齐方向 |
| --- | --- | --- |
| 重新拟题不合并当前候选 | [question-planner.ts:208](../../../../src/lib/geo/question-planner.ts#L208) 从 seed 重新起步；[store.ts:448](../../../../src/lib/geo/store.ts#L448) 只恢复 existing 旧题的选中状态。人工及上轮模型候选移出最新列表，旧 revision 仍在 SQLite，未被物理删除。 | 传入当前候选与已确认题，保存合并、保留、替代和去向，不能重新从种子重建当前库。 |
| 问题诊断不随新观测生产新版 | [research-batch-plan.ts:33](../../../../src/lib/geo/research-batch-plan.ts#L33) 初始化“本批尚未搜索”；新采集只追加观测。[ResearchPanel.tsx:1283](../../../../src/components/geo/ResearchPanel.tsx#L1283) 仍读批次内旧 diagnosis。改进任务的模型诊断存在，但未供此处消费。 | 诊断绑定 run/观测及版本；新搜索后标记待更新，产出新版诊断、承接与缺口评估，保留历史版本。 |
| 消费端新结果缺获取入口 | [research-collection.ts](../../../../src/lib/geo/research-collection.ts) 只调 DeepSeek/Qwen/Doubao API；ChatGPT/Google 消费端结果无自动采集或观测导入动作，公开版不附带历史结果。 | 接入可追溯的新观测生产/导入路径，再接自动采集；不能把 ChatGPT API 当作消费端网页。 |
| 部分页面仍有独立刷新依赖 | 搜索页有请求结束刷新与计划轮询；概览已通过可见时的小版本检查更新。指定历史批次及独立竞品页面仍有各自的读取依赖。 | 边界见[共享刷新审计](../shared.md#数据生产与更新审计)。 |

当前主搜索 UI 支持 DeepSeek 搜索、Qwen/Doubao 联网回答，按服务配置状态启用选项；每日研究跟踪目前仅接受 DeepSeek。本次公开发布未进行收费调用或每日计划真实时间验证。题单人工确认、保留旧问法、原文文件与 SQLite 分存均不是自动化缺陷。

[题目和题单的编辑](#题目和题单的编辑) · [读取列表、详情、图表与原文](#读取列表详情图表与原文) · [单题、勾选批量、搜索全部](#单题勾选批量搜索全部) · [每日问题跟踪](#每日问题跟踪) · [源码与落库](#源码与落库) · [回答里的人工事实核查](#回答里的人工事实核查)

入口 `view=question-plan`；`view=questions` 是同页的“回答记录”子视图。页面中的“搜索问题”输入框仅过滤列表；“搜索全部/搜索”按钮才调用采集接口。

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
| `engine` | `all`；或 `chatgpt/google/deepseek/qwen/doubao` | 详情平台范围 |
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

## 单题、勾选批量、搜索全部

三种选择方式共用 **`POST /api/geo/research`**；不是三个后端执行器。全搜发送本批所有核心题 ID，不受列表搜索/结果筛选影响。费用上限默认关闭；用户可主动开启并设置金额。

```json
{
  "projectId": "example-project",
  "batchId": "example-batch",
  "questionIds": ["Q1", "Q2"],
  "language": "zh",
  "provider": "deepseek",
  "budgetEnabled": false,
  "requestId": "example-search-request-0001"
}
```

示例中的 ID 仅为格式示意，调用时必须从当前响应取真实 ID。

| body 字段 | 必选 / 默认及约束 |
| --- | --- |
| `projectId` | 前端必传；服务端省略时兼容默认项目 |
| `batchId` | 前端必传以冻结本次范围；服务端省略时取最新批次 |
| `questionIds` | 1–8 个不重复 ID，必须为该批 `search_now` 核心题 |
| `language` | 必填 `zh/en`；对应原文必须存在 |
| `provider` | API 默认 `deepseek`，也接受 `qwen/doubao`；各平台真实可用性仍取决于配置与验证 |
| `budgetEnabled` | 新页面默认传 `false`，明确不设置上限；`true` 启用严格上限。省略时兼容旧预算语义，每日跟踪继续沿用原逻辑 |
| `budget` | 开启时必填费用对象；关闭时不需要，后台不使用该值。兼容旧 `budgetLimit` 数字（人民币，上限 2 元） |
| `requestId` | 16–80 位字母、数字、下划线或连字符；同一次意图重试复用，不因网络不确定重新造 ID |
| `scheduleId` | 客户端不得提交；仅保存的每日计划由内部调度关联 |

`MoneyBudget={currency:'CNY'|'USD',amount:number,cnyPerUsd?:number}`：美元必须显式给换算率；人民币按 1。折合人民币向下取到 0.001，必须在 ¥0.005–¥100；这不是实时汇率。DeepSeek 按每题 ¥0.005 预留；问法最多 128 个 Unicode 字符，超长拒绝、不截断。其他回答入口最多 2000 字符，模型/工具按预留处理，不保证预留等于账单。

显式开启上限时，目前仅允许有固定单次费用的 DeepSeek 搜索；所选题目费用超过上限会在发送前拒绝。千问和豆包尚无可确认的请求费用上界，开启上限会拒绝并提示关闭上限或切换 DeepSeek。严格模式不启动额外模型审核或竞品分析，已完成的搜索照常保存，run 标为 `analysisStatus:pending_budget` 并说明原因。关闭上限不再套用隐含金额或预留上限，仍记录已知费用与预留，继续原搜索和分析流程。

关闭上限或兼容旧请求时的后台顺序：校验项目/题目/语言/预算和凭据 → 保存运行 → 复用 `collectLive` → 每题完成立即追加观测、更新费用及完成数 → `analyzeResearchObservation` 校验并追加该条审核 → 本批竞品分析与汇总 → 返回 `{run,batch}`，其中 batch 附带审核与服务端汇总。严格模式跳过上述分析步骤。一个项目只允许一个 running 研究采集，直到已启动的搜索与分析步骤结束才进入终态。原始响应仍落文件，SQLite 保存结构化观测和审核。

审核模型仅在完整正文及原生引用证据就绪时调用；缺证据、模型失败或校验失败保存 unknown，搜索记录仍保留。正常分析流程中的 DeepSeek 纯搜索保存 `not_applicable`，不调用审核模型；严格上限模式不启动该分析流程。审核是否成功看 `answerAudits[].analysisStatus`，不能仅凭 `run.status:completed` 判断；审核持久化异常仍会传回执行器。分析模型费用不包含在研究搜索的 `spent/confirmedSpentCny` 中。

| `run` 关键字段 | 含义 |
| --- | --- |
| `id, projectId, batchId, provider, language, questions[]` | 本次不可变条件，`questions=[{questionId,query}]` |
| `status` | `running/completed/partial/failed/interrupted`；`interrupted` 表示已停止。HTTP 200 也可能返回非完成终态，必须读这里及 error |
| `startedAt, updatedAt, completedAt?, completedCount?, error?` | 执行时间、完成题数和失败原因 |
| `currentQuestionId?, phase?` | 当前题及阶段；`phase=searching\|analyzing\|finalizing` 分别为采集、单条回答审核、本批整理；终态清空，旧运行可缺省 |
| `stopRequestedAt?` | 持久化停止请求的时间；字段存在而 status 仍为 running 时，正在等待当前步骤结束 |
| `budgetEnabled?, budgetEnforcement?` | 新运行明确记录上限开关及 `strict/legacy/disabled`；旧记录可缺省，不回写历史 |
| `budget?, budgetLimit, spent, confirmedSpentCny?, reservedCny?` | 关闭时 budget 缺省且 budgetLimit 为 null；其余 limit/spent 统一人民币。spent 包含不确定费用预留，不能全部标为供应商确认实扣，也不包含分析模型费用 |
| `analysisStatus?, analysisNote?` | `pending_budget` 表示严格上限下搜索结果已保存，额外分析未启动；不代表审核成功 |
| `entryType, evidencePath?, scheduleId?, taskId?` | 入口类型、完整运行原文、计划或导入任务的关联 |

前端运行期间每 1.5 秒通过 `GET /api/geo/research` 读取 runs 与已保存观测，展示当前题、阶段和完成数；返回后更新 batch、显示已保存数与费用，再刷新概览。失败不删除已保存记录；项目切换后忽略迟到响应。相同 requestId+相同条件返回已有 run；条件不同或同项目其他采集在跑为 409。403 为不同 Origin，400 为大部分输入校验，配置/普通异常当前可能返回 500；统一显示 `error`，不自动重发收费请求。

**停止本轮：`POST /api/geo/research`，`{action:"stop",projectId,runId}` → `{run}`。** 停止请求按项目隔离并持久化；重复停止幂等，已结束的运行原样返回，当前项目不存在的 run 返回 404。当前已发出的请求或已启动的分析允许结束，随后不再派发后续问题或启动后续分析；等待期间保持 running 占用，结束后为 interrupted。已完成观测、原始返回和费用记录保留，停止不表示当前请求已撤回或已退费。进度写回不会覆盖并发保存的停止标记。

## 每日问题跟踪

**`GET /api/geo/research/tracking?project=…` → `{plans:ResearchSchedule[]}`**。

**`POST /api/geo/research/tracking`**：

| action | body（还须含 `projectId,action`） | 后端结果 |
| --- | --- | --- |
| `create` | `requestId, questionIds, language, provider:'deepseek', budget`；可选 `batchId,timeOfDay` | 冻结当前批次问法和累计预算；时间默认 `09:00`、北京时间，从明天开始，不立即搜索 |
| `pause` | `planId` | 停止派发下一题/下一次；已发出的请求不保证能取消，结果和费用保留 |
| `resume` | `planId` | 核对剩余预算与未结运行；从明天开始，不补跑漏掉日期 |
| `stop` | `planId` | 永久停止该计划；不能 resume，需要另建计划 |

每次成功都返回当前项目全部 `{plans}`，不是单个 plan。创建时若显式 batchId 已过期返回 409；计划只能使用 1–8 道已审问题和现有对应语言。当前没有修改计划参数的 action，调整题目/预算/时间应停旧建新。

计划字段：`id,requestId,projectId,batchId,questionIds,questions[],language,provider,timeOfDay,timeZone,budget,limitCny,spentCny,reservedCny,status,nextRunAt,lastRunAt,lastRunId,createdAt,updatedAt,error?`。`status=active|paused|stopped|budget_exhausted|failed`；`activeRunId/activeRunReservationCny/activeRunConfirmedCny/ownerPid?` 是执行占用信息，页面不把它当效果数据。

预算是**计划累计上限**，不是每天可重新花一次的额度。后台领取到期计划后调用同一个采集执行器；预算不足停止，未知费用保留预留。应用服务要运行；不是浏览器定时器或云端保证执行。前端有活跃计划且页面可见时每 30 秒读取计划，`updatedAt/lastRunId` 变化后刷新问题结果；隐藏/卸载后停止页面轮询，不影响后台计划。

## 源码与落库

- 页面：[QuestionManagementPanel](../../../../src/components/geo/QuestionManagementPanel.tsx)、[ResearchSearchControls](../../../../src/components/geo/ResearchSearchControls.tsx)、[ResearchPanel](../../../../src/components/geo/ResearchPanel.tsx)、[QuestionDetailVisual](../../../../src/components/geo/QuestionDetailVisual.tsx)。
- 路由：[research](../../../../src/app/api/geo/research/route.ts)、[tracking](../../../../src/app/api/geo/research/tracking/route.ts)；执行：[research-collection](../../../../src/lib/geo/research-collection.ts)、[research-tracking](../../../../src/lib/geo/research-tracking.ts)。
- 类型：[question-types](../../../../src/lib/geo/question-types.ts)、[research-types](../../../../src/lib/geo/research-types.ts)、[question-detail-types](../../../../src/lib/geo/question-detail-types.ts)、[research-store 的 ResearchRunRecord](../../../../src/lib/geo/research-store.ts)、[research-tracking-types](../../../../src/lib/geo/research-tracking-types.ts)。
- 题单修订存 `geo_question_plans`；确认批次存 `geo_research_batches`；追加观测存 `geo_research_observations`；执行存 `geo_research_runs`；每日计划存 `geo_research_schedules`。完整响应经已有原文文件引用读取；首次初始化会导入仓库历史种子，之后不是每次由 AI 手工整理文件。

## 回答里的人工事实核查

`POST /api/geo`，`{action:"save_claim_review",projectId,review}`，不要求 taskId。review 必填 `projectId,batchId,questionId,observationIndex,engine,language,quote,fact,scope,evidenceUrl,conclusion`。observationIndex 必须为非负整数；review.projectId ≤128字符，batchId/questionId ≤200字符。其中结论为 `supported/contradicted/uncertain`；quote ≤8000、fact ≤6000、scope ≤4000 字符，evidenceUrl 为无凭据的 HTTP(S) URL、≤2048 字符。

后台要求当前项目最新批次、观测序号/平台/语言匹配，且是有完整 answerPath 的 ChatGPT 记录；quote 必须出现在已保存原文中，摘要不能代替。保存到 `geo_claim_reviews`，返回完整 GeoState，其中 claimReviews 更新；记录含 id、reviewedAt、reviewer=user。只记录人工结论，不访问依据链接、不调用事实核查模型。

源码：[claim-review](../../../../src/lib/geo/claim-review.ts)、[ClaimReviewPanel](../../../../src/components/geo/ClaimReviewPanel.tsx)。
