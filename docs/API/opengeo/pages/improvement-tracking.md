# 改进与追踪

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

## 数据生产与更新审计

2026-10-28 源码核查：模型诊断、方案生成、独立上下文审核、有界续改、逐轮保存、实施登记、真实复测及策略验证/启用/回退均有代码链路。本轮没有重跑模型或实测；人工批准和实施登记是授权边界。

| 缺口 | 当前行为及证据 | 补齐方向 |
| --- | --- | --- |
| 学习尚无评分偏差分析 | [learning.ts:88](../../../../src/lib/geo/learning.ts#L88) 按上升/持平/下降选三句固定建议，附实施文字；不读独立审核分数、意见及标准版本。已启用经验确会进入后续建议，但这不是完整学习 Agent。 | 在已有策略生命周期中增加有依据的 AI 复盘，提出待验证的策略/评分变更，验证后生效，保留质量底线。 |
| 方案的观察窗口未参与升级判断 | 成功条件是文字；[learning.ts:66](../../../../src/lib/geo/learning.ts#L66) 有一轮完整可比复测即可分类；[strategy-lifecycle.ts:150](../../../../src/lib/geo/strategy-lifecycle.ts#L150) 以新增实测改善判断验证通过，不校验方案承诺的观察天数/最少轮数。 | 审核时冻结可执行验证条件；不足时可显示原始变化，但不可判定策略验证通过。旧文本计划不能靠猜测补条件。 |
| 新依据未完整约束续改上下文 | 新依据已使旧批准不可直接接受/实施；但 [planner.ts:292](../../../../src/lib/geo/planner.ts#L292) 续改资格未检查 reviewContextUpdatedAt，仍复用旧诊断与旧失败审核。 | 诊断和审核绑定依据版本；改变依据后先更新判断，再按有效意见续改，保留旧记录。 |
| 已结束任务再次实测可能不自动刷新 | [monitor.ts:123](../../../../src/lib/geo/monitor.ts#L123) 允许 completed/failed 启动实测，但开始只写锁和事件，不返回单次运行状态；全局仅对 investigating/monitoring 任务轮询。结果会保存，页面未必更新。 | API 返回单次 run 状态并驱动按钮/刷新，业务任务状态与运行状态分开；不需要永远轮询所有任务。 |

历史页固定任务归类另见[历史审计](history.md#数据生产与更新审计)；以上均为待补齐项，未在本轮修改。

[新建与诊断](#新建与诊断) · [审核、手动改稿与自动续改](#审核手动改稿与自动续改) · [实施登记](#实施登记) · [单次复测与每日任务跟测](#单次复测与每日任务跟测) · [真实效果与策略学习](#真实效果与策略学习) · [返回对象与状态字典](#返回对象与状态字典)

正式入口 `view=tasks`（改进任务）与 `view=monitor`（效果追踪）共用 `TaskWorkspace → TaskPanel → WorkflowPanel/TaskTrackingPanel`，选中任务由 `task` 地址参数和 `GeoState.tasks` 定位，没有独立任务详情 GET。

本节动作均走 `POST /api/geo`，除 create_task 外必须传 taskId；审核/实施还需要当前 proposalRevision。通用错误和受理/完成区别见[共享协议](../shared.md#错误与状态)。异步完成读取后续 task.status/error/events；200不能直接显示完成。任务忙碌时仅 pause 可绕过锁；任务观察锁按项目隔离。

## 新建与诊断

| action / 页面操作 | 请求必选字段（另加公共字段） | 可选字段 / 默认 | 成功后的数据及执行边界 |
|---|---|---|---|
| `create_task` 新建任务 | `goal`:非空字符串 ≤2,000 字 | `collectionProvider`: `deepseek`（默认）/`doubao`/`qwen`；`researchContext`；`legacyQuestionPlan:boolean` | 新任务 `queued`，`proposal:null,implementation:null,runs:[]`；默认每日 09:00、7 天、预算 0.5、未启用、replay。仅本地登记；不调用模型或搜索。 |
| `review_research_gap` 核对已有材料 | `taskId` | 无 | 要求已有 `researchContext`；本地计算 `researchGapReview:GeoDiagnosis`，追加事件；不搜索、不批准改稿、不确认产品能力。 |
| `start_workflow` 启动真实任务/历史预览 | `taskId,mode:"live"\|"replay"`；live 必须显式 `budgetLimit:number` | `maxQualityRounds`:整数 1–3，默认 3 | 冻结问题、provider/参数和 protocolKey，旧 workflow 进入 workflowHistory，清空当前方案；`investigating`；依次基线→诊断→候选→独立审核。 |
| `investigate` 重试诊断与审核 | `taskId` | 无 | 要求已有 workflow.baseline，未实施，状态 queued/failed/proposal_ready；复用已存基线，异步重新诊断/生成/审核，不重新搜索。 |

`create_task.researchContext`：必需 `batchId,questionId,language:"zh"|"en",engine:ResearchEngine`；可选 `purpose:"improve_answer"|"investigate_gap"`（默认 improve_answer）、`sourceUrl,gapId,gap,targetAssetId`。前端 `targetUrl/snapshot` 不作为可信输入；服务端从本项目最新研究批次和登记资产重建 `targetUrl`、完整 `snapshot`。`improve_answer` 要求题目为 search_now 且所选语言/引擎有观测；`investigate_gap` 要求匹配已有 gap，允许 keep_and_fill，拒绝 drop_for_now。`sourceUrl` 必须属于所选原始观测，目标资产必须属于项目。

存在 latestResearch 时，不传 researchContext 就必须明确 `legacyQuestionPlan:true`；旧题入口以当前 ready 题单冻结所有 selected 且非 exclude 的候选。带研究上下文时冻结一题及原语言，不将消费者网页历史伪造为 API 基线；snapshot 非 search_now 的核查任务不能启动搜索。

`start_workflow` 只接受 queued/failed/proposal_ready，拒绝已实施或已有完整真实基线；北京时间同任务同日真实基线尝试（含失败）不可重跑。live 需采集配置、诊断模型配置；预算 ≥已用金额+本轮预留且 ≤100。replay 只支持 DeepSeek；不会把新题补成零命中，也不能形成通过审核的实施建议。live 问法限制：DeepSeek 128、其他采集入口 2,000 个 Unicode 字符；不截短原题。

来源：[store.ts:481](../../../../src/lib/geo/store.ts#L481)、[store.ts:543](../../../../src/lib/geo/store.ts#L543)、[research-task-context.ts:33](../../../../src/lib/geo/research-task-context.ts#L33)、[planner.ts:81](../../../../src/lib/geo/planner.ts#L81)。

## 审核、手动改稿与自动续改

以下 `continue_revision/review_plan/accept_plan/confirm_implementation`：任务已有 workflow 时均要求 `proposalRevision` 严格等于当前版本，否则 409；前端从当前 workflow 发送。

| action | 额外必选字段 | 可选字段 | 前置与成功状态 |
|---|---|---|---|
| `continue_revision` | `proposalRevision` | `maxAdditionalRounds`:1–2 的整数，默认 2；UI 固定发 2 | 状态 proposal_ready/failed；须有匹配当前稿的未通过模型审核、完整真实基线、模型诊断及可用模型、未实施。复用原搜索和诊断，异步修订+独立复检；结束 proposal_ready，revision+1，旧 quality 入 history。 |
| `review_plan` | `proposalRevision,after`（非空 ≤50,000 字） | 无 | 状态 proposal_ready/failed，有 workflow 和方案且未实施。保存正文、标 draft、revision+1、旧审核入 history 并清除当前 quality；异步只审核用户完整候选一次，不自动改写。 |
| `accept_plan` | `proposalRevision` | `after`（省略用当前稿） | 状态 proposal_ready；正文若改变，或无匹配当前方案摘要且晚于证据更新时间的通过审核，拒绝。成功 `proposal.status=accepted,task.status=awaiting_implementation,workflow.stage=implementation`；不调用模型、不发布。 |

后台完成诊断/审核后无论通过与否都可能为 `task.status=proposal_ready`，必须进一步看 `workflow.quality`。`canContinueRevision` 是后端计算的便利字段；前端正文改动 dirty 检查、展示 stage、轮次对比和分数折线只是展示派生，不替代服务端授权判断。

审核门槛：四维 `evidence/relevance/actionability/verifiability` 每项 ≥70、平均 ≥80、没有 blocking；由程序算 passed，不接受模型自报。`QualityLoop.stopReason` 为 `target_reached/no_progress/round_limit/needs_configuration/needs_evidence`；达到门槛、无进步或轮次用完就停，并保留最佳轮。缺配置/证据时只返回 source=local 结构检查，原始 0 分代表未评分，前端演进图用 null 展示。

独立审核是同一配置模型的一次新上下文请求，接收完整诊断和候选，不带写作者对话与之前分数；并非另一个独立部署模型服务。诊断、起草、复检与自动续改使用已配置模型，费用不纳入任务采集预算，也没有在该协议内报告 token/金额。

来源：[store.ts:594](../../../../src/lib/geo/store.ts#L594)、[planner.ts:191](../../../../src/lib/geo/planner.ts#L191)、[planner.ts:277](../../../../src/lib/geo/planner.ts#L277)、[quality.ts:22](../../../../src/lib/geo/quality.ts#L22)、[quality-evolution-data.ts:30](../../../../src/components/geo/quality-evolution-data.ts#L30)。

## 实施登记

`confirm_implementation` 请求：公共字段 + `proposalRevision`（有 workflow 时必选）、`kind:"rehearsal"|"user_confirmed"`；`note?` ≤3,000 字，`url?` ≤2,000 字（省略取 proposal.targetUrl），`occurredAt?`。

- 通常要求状态 awaiting_implementation/monitoring/paused、方案 accepted、当前审核仍有效。
- user_confirmed 要求非空 note、URL、occurredAt；URL 为 http(s)，有 workflow 时必须匹配已审目标 origin 和去尾斜杠后的 pathname。
- occurredAt 必须完整带时区，是真实日历日期，不晚于登记时间，不早于当前方案通过审核时间；前端将 datetime-local 转为 ISO。登记时间 `at` 由后端生成。
- 已有完整真实实施不能覆盖；仅允许历史 user_confirmed 缺 occurredAt 时补日期，此时也接受 completed/failed，保留原 note/url/at、任务状态和跟测设置，只补日期、清旧 outcome 后重算效果。
- 新登记成功后，返回的完整 GeoState 中 `task.implementation={kind,note,url,at,occurredAt?,proposalRevision?,proposalDigest?}`，任务与 workflow 进入 monitoring。workflow 任务保持 `monitor.enabled=false,nextRunAt=null,mode=replay`，需要另设跟测；旧无 workflow 任务会启用历史回放。
- 这是用户实施声明，未独立核验链接，也不改写或发布远端页面；rehearsal 不能进入真实效果比较。

来源：[store.ts:631](../../../../src/lib/geo/store.ts#L631)、[implementation.ts:2](../../../../src/lib/geo/implementation.ts#L2)、[OpenGeoApp.tsx:595](../../../../src/components/geo/OpenGeoApp.tsx#L595)。

## 单次复测与每日任务跟测

| action | 请求字段 | 行为、约束与结果 |
|---|---|---|
| `update_monitor` | 必选 `monitor:{...}`；可选补丁 `mode:"live"\|"replay",timeOfDay:"HH:MM",days:1..90整数,budgetLimit:number,enabled:boolean` | 未给字段保留；budgetLimit 不低于 spent 且 ≤100；days 根据已经消耗的计划天数重算 remaining。enabled 要求已实施且 remaining>0。成功写整个 GeoMonitor、下个北京时间时点和事件；有实施则 task.status=monitoring。 |
| `run_monitor` | 必选 `mode:"live"\|"replay"` | 已实施，状态 monitoring/paused/failed/completed；异步增加 runs；真实模式额外要求未暂停、当天未实测、user_confirmed、已在设置中选择 live、有效配置、同实施版本和足够一轮预算。单次手动运行不消耗 remaining。 |
| `pause` | 无额外字段 | 状态 monitoring/failed；设置 paused、disabled、nextRunAt=null。已发出的请求会保存结果，循环发现暂停后不发余下题；不是立即中断网络请求。 |
| `resume` | 无额外字段 | 状态 paused/failed，已有实施、remaining>0；live 另需配置、真实实施及预算。设 monitoring、enabled、下一北京时间时点，清 error；不补造离线数据。 |
| `reflect` | 无额外字段 | 要求 workflow+implementation；本地重算 workflow.outcome，可能新增策略候选，无搜索和模型请求。真实跟测完成/失败后也自动执行同样复盘。 |

单次 `run_monitor` 不设置 running 状态，也不立即追加占位 run；完成后才追加。若从 failed/completed 状态执行且没有其他 investigating/monitoring 任务，当前共享轮询条件不会因此成立，页面不会可靠地自动显示本次完成结果；需要重新读取状态。这是现有刷新限制。

切换 `update_monitor` 到 live 必须本次显式给 budgetLimit；即使 enabled=false，只要 mode=live 也校验采集配置、真实实施和一轮剩余预算。replay 仅 DeepSeek 可用。UI `costConsent` 是复选框的前端状态，未作为请求字段；后端依靠模式、配置、预算、实施记录等校验，没有独立 consent token。

每日任务跟测：`startGeoScheduler()` 由 GET/POST `/api/geo` 启动；立即 tick，之后每 30 秒扫描两项目。已到时的 monitoring+enabled 任务启动一轮；同日已有真实运行则排下一日。只有 scheduled 运行会 remaining−1；到零变 completed 并关闭，失败变 failed 并关闭，partial 保留记录继续计划。服务进程不在时不运行；恢复后不按离线天数补跑。

收费触发是 live 基线或 live 跟测实际发出供应商请求：DeepSeek 每题预留 ¥0.005，已知 HTTP 非成功/空结果会退预留；超时或不可解析成功返回保留预留且不自动重试。豆包/千问每题预留 ¥0.10、`costEstimated:true`，失败也不凭推测退款；实际费用由供应商账单决定，预留不是供应商保证上限。replay、登记、复盘、策略状态转换不调用收费模型/搜索。上述价格是源码中的配置与文案，不代表已核对当日供应商计价。

DeepSeek workflow 采集参数为 `count:50,need_content:true`，旧固定题路径为 need_content=false；豆包/千问采集联网回答，命中依据原生 citations，rank=null、aiCited=projectHit，不把 sources 列表直接当原生引用。完整原文、失败及请求参数保存在文件，API 返回 run 含结构化结果；未取得结果时 hitCount=null，不是零。

来源：[store.ts:677](../../../../src/lib/geo/store.ts#L677)、[monitor.ts:123](../../../../src/lib/geo/monitor.ts#L123)、[scheduler.ts:6](../../../../src/lib/geo/scheduler.ts#L6)、[providers/config.ts:15](../../../../src/lib/geo/providers/config.ts#L15)、[answer-monitor.ts:27](../../../../src/lib/geo/answer-monitor.ts#L27)。

## 真实效果与策略学习

`evaluateOutcome` 在后端决定比较资格：必须完整 live 基线和 followup、无 error、同 protocolKey/题目原文/语言/provider/资产目标；题数与结果完整，时间有效，基线在冻结后、真实实施前完成，复测不早于真实实施且 implementationRevision 匹配。replay/failed/partial/旧版本均排除。基线比率与所有合格复测的总命中/总题数比较，得到 improved/unchanged/worse；不足为 inconclusive，不提供因果证明。

前端 `realFollowupRuns()` 只是实施后真实记录清单，不能当可比集合；趋势图通过后端 outcome.baselineRunId/followupRunIds 选择记录，没有另算较宽松的可比规则。`GeoOutcome` 包含 `classification,summary,evaluatedAt,baselineRunId,followupRunIds,beforeRate,afterRate,evidencePaths,limitations`；比率可为 null。

| action | 额外必选字段 | 后端规则 / 成功变化 |
|---|---|---|
| `validate_strategy` | `strategyId`（非空 ≤180 字）、`version`（严格匹配当前版本） | 只对当前 taskId 的 candidate/reverted；校验项目、目标、类别、协议、基线、实施版本。使用候选产生/回退后新增且未使用的真实记录；只有 improved 才变 validated，否则维持原状态并写 validation_failed。 |
| `activate_strategy` | `strategyId,version` | 仅 validated、最新验证通过且观察提升、有完整来源可启用；变 active，版本+1，保留 history。同协议同目标既有 active 自动回退。 |
| `revert_strategy` | `strategyId,version,reason`（非空 ≤1,000 字） | 仅 active 可回退，变 reverted、版本+1、记录原因，后续不再用于候选生成。 |

真实可比结果可形成 `StrategyMemory` candidate（包括 unchanged/worse 的观察），但不会自动生效。后续方案只取同项目、同目标、同类别、同协议且 validated→active 的其他任务策略，最多 8 条；不是自动改评分权重。策略操作错误被包装为 400，包括版本不一致；没有搜索/模型请求。

来源：[learning.ts:11](../../../../src/lib/geo/learning.ts#L11)、[strategy-lifecycle.ts:81](../../../../src/lib/geo/strategy-lifecycle.ts#L81)、[store.ts:521](../../../../src/lib/geo/store.ts#L521)、[TaskOutcomeHistory.tsx:24](../../../../src/components/geo/TaskOutcomeHistory.tsx#L24)。

## 返回对象与状态字典

| 对象 | 直接用于页面的结构；完整类型位置 |
|---|---|
| `GeoTask` | `id,projectId?,title,goal,status,createdAt,updatedAt,blocks,events,proposal,implementation,monitor,runs,source,error?,workflow?,workflowHistory?,researchContext?,researchGapReview?,assetGovernance?,reviewContextUpdatedAt?,canContinueRevision?,collectionProvider?`。`status`: queued/investigating/proposal_ready/awaiting_implementation/monitoring/paused/completed/failed。 |
| `GeoProposal` | `id,title,status,rationale,targetAssetId,targetUrl,before,after,changes[],evidencePaths[],successCriteria[],limitations[]`；status 类型目前为 string，代码使用 draft/unreviewed/needs_review/reviewed/accepted。 |
| `GeoWorkflow` | `version:1,collection?,maxQualityRounds?,questionPlanId,questionPlanRevision,frozenAt,questions[],protocolKey,stage,baseline?,diagnosis?,quality?,qualityHistory?,proposalRevision,appliedStrategyIds[],outcome?`；stage: search/diagnosis/quality/implementation/monitoring/reflection。 |
| `GeoDiagnosis` | `summary,findings[{id,observation,hypothesis,evidencePaths,uncertainty}],comparisons[{questionId,sourceUrl,observedDifference,evidencePath}],recommendedAction,limitations,source:"model"\|"local",createdAt`。 |
| `QualityLoop/Review` | loop: `maxRounds,targetScore,minimumDimensionScore,stopReason,rounds[{round,candidate,review}],bestRound`；review: `criteriaVersion,proposalDigest,reviewedAt,source,scores,total,passed,issues[{dimension,severity,detail,suggestion}],summary`。 |
| `GeoRun` | `id,at,completedAt?,measurementAt,mode,status,queryCount,completedCount,hitCount:number\|null,resultCount,cost,costEstimated?,summary,questions:GeoQuestion[],error?,phase?,protocolKey?,implementationRevision?`；status completed/partial/failed；phase baseline/followup。 |
| `GeoMonitor` | `enabled,mode,timeOfDay,days,remaining,nextRunAt,budgetLimit,spent,queryIds,lastRunAt`；日期字段可 null。 |
| `StrategyMemory` | `id,taskId,projectId,createdAt,status,version,history,validation?,targetAssetId,categories,protocolKey,outcome,recommendation,action,beforeRate,afterRate,baselineRunId,followupRunIds,evidencePaths,implementationRevision,confidence:"observational",originalCreatedAt?`。 |

完整字段真源：[types.ts:75](../../../../src/lib/geo/types.ts#L75)、[workflow-types.ts:5](../../../../src/lib/geo/workflow-types.ts#L5)。其中任务阶段、review passed、策略资格、效果分类由后端提供；页面阶段标签、比较图、标题、分组、筛选为前端派生。
