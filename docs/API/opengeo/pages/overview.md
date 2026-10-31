# 概览

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-30。描述当前代码协议；新增或变更接口时同步维护本页。

## 重点改进显示顺序

`GET /api/geo/overview-order?project=…` 返回 `{projectId,questionIds:string[]}`；没有偏好时返回空数组，沿用页面默认顺序。`POST /api/geo/overview-order` 接受同形 JSON 并返回保存后的值；要求同源 `Origin`，拒绝跨源/跨站写入。项目必须存在，编号数组最多 1000 项且不能重复，每项为不含首尾空白及控制字符的 1—256 字符字符串。空数组重置为默认顺序；响应均为 `no-store`。

偏好只存在当前项目 SQLite 的 `geo_overview_order` 表，不改变研究批次、题目、评分或观测，也不启动搜索、模型或调度。客户端提交完整显示顺序；筛选视图只移动可见问题的槽位，隐藏或历史编号可保留，服务端不根据当前题单删除它们。

## 竞品推荐小卡

维护入口：[概览 Agent 导航](../../../../skills/pages/概览.md)。竞品判断与表达复用[竞品推荐提示词](../../../../skills/competitor-analysis/SKILL.md)，数量及运行参数共用同目录 [parameters.json](../../../../skills/competitor-analysis/parameters.json)，不另建概览推荐 Agent。

概览复用竞品候选接口，传入当前项目、批次、语言和平台。只展示一张紧凑小卡，包含已核实推荐或已选参照、具体实测依据和完整同题比较。点击“查看详情”直接进入竞品页；直接选择参照留在概览，原位更新为当前参照。竞品页未选时最多展示 3 个推荐并突出首项，选定后按“漏在哪道题 → 原回答依据 → 具体改什么 → 复测结果”展开。默认展开第一条真实漏题，多题可切换，同题各平台分别保留；详细行动不展开到概览。选择发送项目限定的 `geo-competitor-changed` 事件，立即重读。

未选时只展示通过相关性审核、当前范围存在完整正向提及记录且能绑定实际回答的对象。介绍说明它是什么，依据指出哪道问题、哪个平台的回答提及它；未完成对象不推给用户选择。推荐顺序使用当前范围的实测结果，不使用旧 AI 评分，并列或不可比不宣称唯一第一。

完整同题对比优先沿用当前范围；全部平台不完整时可展示明确标注平台的完整同题结果，指定平台没有完整对比时不改用其他平台。不能删掉未知记录后重新计算全平台比例。底层数据复用 `overviewMetrics`，AI 指标按题等权，网页搜索不混入 AI 提及，来源链接不冒充原生引用；双方精确率已知才显示差值，不代表行业份额。原始数据和缺数原因保留在详情。竞品页另按选定时冻结的可比样本计算自身进步和追近参照，有有效复测数值时展示结果，0 变化显示持平；没有可比结果时保留一条轻量待复测或待核实状态。百分比和复测状态不扩成概览的新主卡。选择参照、打开详情或改进窗口不自动执行改动、发布或运行复测。

问题详情也复用候选组件，按项目、批次和问题显示已审核推荐的发现依据；候选预览和设为对标可直接完成，关联问题链接保留原批次、平台、语言、观测及返回位置。完整接口、引用审核和 AI 生成/失败规则见[竞品对照](competitor.md)。

## 数据生产与更新审计

当前研究采集执行器在每题观测落库后调用 `analyzeResearchObservation`，保存该条回答的提及/引用审核；共享状态及研究接口附带已保存审核与服务端汇总。概览可见时检查小版本，变化后重读状态；同批新观测、审核和 Target 变化可更新概览及其竞品摘要。

主搜索 UI 支持 DeepSeek 搜索、Qwen/Doubao 联网回答，按服务配置状态启用选项；每日研究计划目前仅支持 DeepSeek。本次公开发布未进行收费调用或每日计划真实时间验证。ChatGPT/Google 消费端仍没有持续采集或观测导入动作。也不自动重写问题的 `diagnosis`，人工“说法核查”仍是独立数据。

## 回答审核的生产与校验

`collectResearch` 的顺序为保存原始证据 → 追加观测、更新运行费用及完成数 → 审核该条观测 → 最终返回 `{run,batch}`。已有观测不会因审核失败而删除。网页搜索记录保存 `analysisStatus:not_applicable`，不调用审核模型；缺证据保存待核实结果，也不调用模型。

进入模型审核前，必须有非空完整正文，以及采集器提供的 `CollectedAnswer.evidence={answerComplete:true,citationsComplete:true,citationSource:'native'}` 和合法原生 `citations`。这些完整性字段来自采集器，不能由审核模型自行声明。缺任一项时，`mention/citation` 都保留 `unknown`；搜索来源列表和正文普通 URL 不冒充平台原生引用。

模型结果必须完整返回 `mention, citation, mentionEvidence, citationEvidence, officialUrls, answerComplete, limitations, mentionQuote, identity`；schema 严格校验，不补默认字段或修复后重试。`mention/citation` 只接受 `yes/no/unknown`，`identity` 为 `matched/unrecognized/excluded/ambiguous/absent`，两项依据不得为空。程序进一步校验：

- 提及摘录须逐字存在于正文；`mention:yes` 须含项目名/别名、身份为 `matched`，并排除已知同名对象。正文含项目名时，不能无依据判 `no`；明确不认识该项目可为 `no + unrecognized`。
- `citation:yes` 的 `officialUrls` 必须来自本次原生引用，且属于项目官网、仓库或已登记的自有已发布内容。存在自有原生引用却判 `no`、未确认引用却返回已确认链接，均不采用。
- 不完整回答的两项结论必须为 `unknown`；未知或不完整必须给出 `limitations`。字段或语义校验失败，整条审核保存为 `failed` 和两项 `unknown`。

启用订阅分析时使用所选 ChatGPT 模型，否则使用 API 分析模型。每条最多一次请求，不自动重试或切换供应商；输入与超时上限从 [回答审核参数](../../../../skills/answer-evidence-review/parameters.json) 读取，默认输入含消息和 schema 最多 32 KiB、API 超时 45 秒、订阅分析超时 180 秒。超出材料上限保留原文待核实，不截断。缺配置、模型失败或超时也保存未知及原因；持久化错误继续传给采集执行器，不能伪报审核已保存。分析模型费用不属于研究搜索 `budget/spent` 的已确认费用。

源码：[answer-audit](../../../../src/lib/geo/answer-audit.ts)、[research-collection](../../../../src/lib/geo/research-collection.ts)、[采集证据类型](../../../../src/lib/geo/providers/types.ts)。

## 返回字段与统计口径

没有完整 `/api/geo/overview` 接口。`GET /api/geo?project=…` 的 `latestResearch`、`GET /api/geo/research?project=…&batch=…` 的 `batch`，以及搜索 POST 返回的 `batch`，均通过 `attachOverviewData` 附加以下字段；历史批次须校验项目与批次，错误不会伪装成别批数据。

| `ResearchBatch` 字段 | 当前内容 |
| --- | --- |
| `answerAudits` | `AnswerAuditRecord[]`；每个精确观测读取最后追加的有效审核。类型可选，当前组装函数始终提供数组 |
| `overviewMetrics` | `Record<string,{mention:MetricSummary,citation:MetricSummary}>`；键为 `${language}:${engine}`，语言 `zh/en`，入口 `all/chatgpt/google/deepseek/qwen/doubao` |
| `updatedAt` | 原批次更新时间与审核追加时间取较新值，供消费者更新；不覆盖原始观测时间 |

`AnswerAuditRecord` 包含 `projectId,batchId,questionId,engine,language,recordedAt,evidencePath,mention,citation,mentionEvidence,citationEvidence,officialUrls,answerComplete`。新记录还带 `schemaVersion:1,reviewedAt,method,analysisStatus,limitations`；`method` 为 `model/legacy/unavailable`，`analysisStatus` 为 `complete/needs_review/failed/not_applicable`。模型的 `mentionQuote` 通过校验后追加到 `mentionEvidence`；`identity` 用于校验，不是独立持久化字段。

审核必须精确匹配项目、批次、问题、入口、语言、`recordedAt` 和 `answerPath ?? evidencePath`；只读相同观测的审核，不给新回答套旧结论。存储层保留旧记录兼容迁移机制，公开版没有附带旧审核；详情见[存储](../storage.md)。读取审核和组装指标不调用模型或重新搜索；共享 GET 的既有调度行为见[刷新与调度](../shared.md#刷新与调度)。

`MetricSummary={rate,minimumRate,yes,no,unknown,completed,unmeasured,questions}`。`rate/minimumRate` 为百分比或 null，其余为计数。每个问题、语言、入口取最近保存的观测；先在同题已测回答内平均，再对问题等权平均。`unknown` 使精确 `rate` 为 null；`minimumRate` 只给已确认肯定结果的下界，不把未知结论改成否定。未测不进入已测分母，无已测回答时两种 rate 均为 null。

AI 指标按 `entryType:web_answer/api_answer` 识别，`web_search/api_search` 排除。缺 `entryType` 的兼容记录按 ChatGPT/Qwen/Doubao 识别为回答。`engine:all` 汇总同语言下的 AI 回答入口，Google 普通网页和 DeepSeek 纯搜索仅显示来源命中；不同模型、地区或登录条件不会因聚合自动变成可比较条件。

前端顶部提及率、引用率及平台提及汇总直接消费 `overviewMetrics`；逐题筛选、来源计数、可视化、竞品配对和详情跳转仍有前端派生。顶部不展示日期或问题分类，默认查看当前题单的全部问题；采集时间取观测 `recordedAt`，显示在具体结果里，没有独立 `dateFrom/dateTo` 查询。旧无批次分支仍使用 `visibility`。

## 概览刷新

`GET /api/geo/overview-version?project=…` 返回 `{projectId,version:string}`；`version` 是不透明的变化标记，客户端只比较是否相等。当前由批次/观测/回答审核及竞品引用审核表的追加序号、研究运行更新时间及 `competitor.json` 修改时间生成，响应 `no-store`，不返回完整批次。这个小版本路由只读已有状态，不启动调度器、搜索或模型。

仅概览可见时每 10 秒检查版本；第一次成功读版本、版本变化、重新聚焦或恢复可见时读取共享状态，版本未变的定时检查不重读完整包。隐藏、离开概览或卸载时停止检查并取消请求；切换项目后丢弃旧响应。共享 GET 仍保留已授权计划的调度行为，不能把整套刷新描述成绝对无任务副作用。

`ProjectOverview` 收到新批次对象后重取 `/api/geo/competitor?project=…` 并校验 `projectId`，覆盖同批追加及仅 Target 变化；筛选平台本身不新发搜索。历史观测链接仍指向原记录，不被刷新改写。

源码：[overview-data](../../../../src/lib/geo/overview-data.ts)、[overview-metrics](../../../../src/lib/geo/overview-metrics.ts)、[overview-version route](../../../../src/app/api/geo/overview-version/route.ts)、[OpenGeoApp](../../../../src/components/geo/OpenGeoApp.tsx)、[ProjectOverview](../../../../src/components/geo/ProjectOverview.tsx)、[ResearchPanel](../../../../src/components/geo/ResearchPanel.tsx)。
