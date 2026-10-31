# 竞品候选与对照

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-29。描述当前代码协议；新增或变更接口时同步维护本页。

提示词与参数统一从[竞品页面维护入口](../../../../skills/pages/竞品对照.md)进入；[推荐标准](../../../../skills/competitor-analysis/SKILL.md)是运行时实际读取的提示词。

## 数据生产与边界

候选来自当前项目已保存的核心题观测。GET 只做本地读取、提取与对照；新采集完成回答审核后生成竞品分析，旧记录通过用户主动生成或更新发起分析 POST。不发起额外搜索。当前提取范围是具体 GitHub 仓库根入口，以及来源标题与独立主页域名相符的品牌入口；排除纯自身品牌导航题中的同名误命中、自身、已知媒体/社区、文章、仓库 issue/讨论/源码子页、自荐、镜像和明显合集。不凭任意来源域名推定竞品，不自动合并同名不同仓库，也不推断仓库与网站属于同一产品。

发现的身份线索经现有分析模型审核相关性后成为候选。模型根据带编号原文生成介绍、适用理由、学习特点、局限和问题改进机会，程序校验逐字摘录及问题归属。新版 `competitor-v2-relevance-only` 不生成数值评分；历史 scores 仅保留数据，不参与门槛、排序或同分裁决。

推荐卡只接收新版相关性审核通过、当前范围提及已完整核实且存在正向命中，并能绑定当前最近回答中实际身份命中的对象。其他候选保留原始数据和预览能力，不占推荐名额，也不否决已完成核实的对象；无合格对象时概览不展示未完成推荐。介绍说明已确认的用途，推荐依据直接指出被哪道问题、哪个平台的回答提及；影响推荐成立的身份或能力缺口须阻止推荐，其他局限单独保存在 limitations。

只在达到交付条件的对象中按实测表现排序；相同已测回答、相同未测数量且提及结论完整时，按 AI 提及率降序。提及率相同时，仅在同组官方引用也完整可比时以引用率比较。完全并列或不可比时不宣称唯一第一；相同缺测不阻止比较同一已测集合。纯网页搜索范围没有 AI 提及率，不生成推荐卡。Google 仅使用带正整数 position 的常规网页结果，概览链接不参与发现或对照。

发现历史保留在数据库中；用户推荐数量由 [parameters.json](../../../../skills/competitor-analysis/parameters.json) 的 `maxRecommendations` 控制，默认 3、校验范围 1–3，主要 Target 只有一个。未选时最多显示 3 个推荐并突出首项，不自动保存选择；新顺序不替换已选对象。选定后切换为逐题差距与行动。关注不改变 Target；选为 Target 同时关注；取消关注不清空 Target。手动设置入口继续保留。

竞品页保留完整介绍、实测对照、选定后的差距与改进机会。Overview 只保留一张参照小卡、双方提及率和具体推荐依据；“查看详情”进入竞品页，“以它为参照”保存后停留 Overview。两处共用分析结果、实测交付条件和推荐顺序，不把旧 AI 理由当作排名依据。

小卡优先使用当前范围的完整同题对比。全部平台结果不完整时，可展示一个双方均完整的单平台同题结果，并明确标明该平台；指定平台没有完整对比时不改用其他平台。统计源、分母和底层未知状态保持不变，不删除未知后重算全平台比例。卡片不展示未完成的比较数值或审核计数；竞品页推荐卡及选定后的摘要同样只显示已核实的可比指标；选定后可展开全部指标，查看原始缺数、详细观测与审核原因。

## 选定后的逐题行动

页面主线是“漏在哪道题 → 原回答依据 → 具体改什么 → 复测结果”。真实漏题仅指当前范围的同一最近 AI 回答中 `ownMention.status=not_seen` 且 `targetMention.status=matched`；`unknown`、网页搜索命中和历史回答不替代这一判断。按原题顺序默认展开第一条真实漏题；有多题时可以切换，同题各平台结果分别保留。没有真实漏题时显示现有对照或待核实状态，不编造漏题。

所选题目连接对应平台、语言、观测时间、摘录和原回答入口。每个平台的回答分别配对应建议；AI 机会只在其问题和证据精确属于当前回答时显示，不同题、平台、语言、批次或新旧回答的机会不拼接使用。当前回答没有对应机会时引导先读原回答，用户可进入原问题继续分析，不展示不相干的建议。

行动优先说明改哪个已知页面或文档、补什么内容、再用原问题如何复测；输入没有具体资产时只能明确建议新增内容，不能编造路径或地址。`title` 使用动词和改动对象，`action` 保留完整可执行要求；`observed` 与 `hypothesis` 分开，后者保持推测。建议不代表已经改动、发布或复测。

复测按选定时的漏题与当前漏题逐题保留；问题补上后仍可看到其改善结果。双方百分比作为辅助对照。可比复测已有有效结果时展示变化，`ownChange` 或 `gapChange` 为 0 也明确显示持平；两项均无数值时只保留一条轻量待复测或待核实状态，不以空的大卡替代行动。比较口径和未知值处理沿用下方“分母与刷新”，不会为改善展示而重算分母或把未知写成零。


## 接口

| 操作            | 接口 / 请求                                                                                                 | 返回与职责                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 当前对照        | `GET /api/geo/competitor?project=<id>&batch=<可选>`                                                         | `CompetitorComparison`；不传 batch 时用最新批次，指定批次必须属于项目         |
| 手动保存 Target | `POST /api/geo/competitor`，`{projectId,target,batchId?}`                                                   | 保存后返回所选批次对照，默认最新；不重新搜索                                  |
| 发现/读取候选   | `GET /api/geo/competitor-candidates?project=<id>&batch=<可选>&language=zh&engine=all`                                              | `{projectId,batch,target,candidates,ranking,analysis,selectedCandidate,selection,comparison?}`；candidates 最多 3 个；已有 Target 时附 comparison |
| 保存前预览      | 同上加 `candidate=<id>`                                                                                     | 加 `previewCandidate` 和该身份的 `comparison`；支持不在当前前三的历史候选；不改变 Target |
| 关注/取消/选择  | `POST /api/geo/competitor-candidates`，`{projectId,action:'save'或'unsave'或'select',candidateId,batchId?}` | 返回更新后的候选列表；服务端只接受当前项目可见的候选 ID，不接收客户端伪造身份 |
| 生成/重试分析 | 同上，`{projectId,action:'analyze',batchId?,force?}` | 一次有界模型请求；相同输入复用已保存成功或失败结果，force 才显式重试 |

`language` 默认 zh，`engine` 默认 all；GET 和全部 POST 响应均按请求范围排序。`ranking` 提供当前范围、能否排序、原因及有证据支持的唯一 `leaderId`；候选 `recommendation` 提供实测原因、可选名次和 `isLeader`。

`POST` 的 `action:'audit-citations'` 重新核对已有完整原生引用并保存结论，不运行新搜索或模型。新竞品分析成功后也自动核对已有引用。

GET 省略 project 默认 `example-project`；POST 要求 projectId 为 string。未知项目、批次或候选返回 404，格式无效返回 400，不同 Origin 返回 403，其他错误 500。成功响应 no-store。指定 batch 无效时在保存前拒绝，不更改设置。

打开竞品页或概览只读取保存结果，不自动提交分析。当前输入尚未完成时，优先展示同项目、同批次的上次成功推荐，保留生成时间并标记为旧分析；不同批次不混用。新搜索完成后的分析及用户主动生成/更新，会保存实际阶段、开始时间、候选数和证据摘录数，页面每 2.5 秒只读检查进度。分析期间旧推荐仍可查看和选择，失败也保留旧结果；初次没有结果时提供生成入口。读取超时显示重新读取，过期或中断的分析有明确失败状态，不无限加载。

`target={name,aliases,officialUrls}` 或 null。name 非空、≤120字符；aliases 数组必填、最多12项，可空；每项为非空字符串、≤120字符且无控制字符；officialUrls 为1–6个无账号密码的 HTTP(S) URL，各≤2048字符，去 query/hash。后台生成 updatedAt；null 清空 Target。

## 模型

`CompetitorCandidate`：`id,name,aliases[],officialUrls[],description,reason,saved,questions[],analysis?`。ID 由项目与具体入口确定，同名不同仓库保持独立。analysis 含状态、介绍、相关性理由、历史可选 scores（不参与排序）、strengths、opportunities、limitations、evidenceIds、quotes、generatedAt、model、version、recommended；未完成时没有伪造的分数。机会沿用 `questionId,title,observed,hypothesis,action,evidenceIds`：分别表达原问题、改动对象、观测、待验证解释及行动，并绑定原回答证据，不新增行动字段或独立 Agent。

`CandidateQuestion`：`batchId,questionId,question,language,engine,recordedAt,evidencePath,answerPath?,observationIndex,sourceUrl,excerpt,evidenceId?`。摘录来自已读正文名称附近或原来源标题，保留原始来源和批次。已关注但当前批次没有再出现的候选保留此前依据；不能把历史关联问题显示成当前批次记录。

具体身份被来源发现后，会复用已读正文关联同批其他非品牌导航题中的名称/别名命中；无实际官方来源时 sourceUrl 为空，原回答与正文摘录作为依据，不从摘要推断或新增身份。

| CompetitorComparison 字段          | 含义                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId,own,target,batch`       | own 含 name/aliases/officialUrls；target 多 updatedAt 或 null；batch={id,date} 或 null                                                 |
| `rows[]` 定位/条件                 | `id,questionId,question,query,observationIndex,engine,entryType?,language,recordedAt,collectedAt?,conditions,evidencePath,answerPath?` |
| `answerAvailable,sourcesAvailable` | 是否成功读取正文、是否有筛选后的来源；sourcesAvailable=false 不能区分零来源与未保存                                                    |
| `ownMention,targetMention`         | `{status:matched或not_seen或unknown,names[],excerpts[]}`                                                                               |
| `sources[]`                        | ResearchSource 加 `own:boolean,target:boolean`；第三方来源保留；官方归属独立匹配                                                       |

rows 支持 ResearchEngine 的 ChatGPT、Google、DeepSeek、千问、豆包，并保留 entryType。网页搜索不当作 AI 回答。正文支持已登记 ChatGPT 文本段、标准 answer_text 等 JSON、千问/豆包完整响应及明确标记 api_answer 的归一化 `.answer.md`。缺失、失败、不完整或未知格式保留 unknown。自己的名称匹配优先遵从精确项目/批次/问题/平台/语言/时间/原文路径匹配的持久审核；审核 no 不会被同名文本覆盖，缺审核或审核不完整保持 unknown。候选正文名称匹配不等于已核实身份、推荐或排名。

官方 URL 按主机、端口、路径及子路径匹配，同域其他仓库不计入。GitHub 的 owner/repo 忽略大小写，其下文件路径仍严格匹配；候选名称链接明确指向另一同名仓库且没有本候选身份链接时，提及保持 unknown。未见官方入口不代表未收录。

## 分母与刷新

预览从所选完整批次生成对照，包含候选未出现的题和正文不可读的观测，绝不以候选关联题作为分母。`performance.scopes[language:engine]` 在读取时计算，包含指标列表及双方 `MetricSummary`；不持久化成全局分数。我方 AI 指标直接复用 `overviewMetrics`，搜索指标复用 `getResearchMetrics`。双方使用 `getResearchRows` 选择的同一批次、同题、同语言、同平台最近记录，先确定最新记录再区分 AI 回答和网页搜索。AI 指标按题等权；未知保留在已测分母中，有确认命中时可展示下限，双方精确率都已知才显示百分点差距。竞品官方引用没有对应审核时显示待核实，不能把来源链接匹配当作已引用。

项目 SQLite `db.sqlite` 中的 `geo_competitors` 保存身份、AI 介绍、理由和发现依据，`geo_competitor_analyses` 保存按输入版本复用的分析结果，`geo_competitor_selections` 追加选定时的对照快照，`geo_competitor_state` 指向当前 Target。`geo_competitor_citation_audits` 追加保存竞品引用审核，精确绑定项目、批次、问题、平台、语言、观测时间、原文路径和竞品身份。

引用审核只接受完整回答和完整平台原生引用：先核对引用 URL 是否属于已保存的竞品官方入口，确定 yes/no；搜索 sources、普通正文链接不冒充原生引用。可选独立模型审核使用 `skills/competitor-citation-review` 的提示与参数，结论仍须通过原生 URL 和归属校验。未展开引用组、缺完整捕获、调用失败或归属不明均保存 unknown 及具体原因，页面可展开查看。默认打开页面不触发审核或模型；首次显式核实可复用历史独立审核过的完整捕获，不覆盖原搜索证据。历史评分继续保留但不再参与推荐。

选定时保存 `CompetitorSelection {id,projectId,batchId,candidateId,selectedAt,baseline:{batch,rows}}`。重复保存同一参照不重置基线。`competitor-progress.ts` 同时计算自身提及率变化和参照差距缩小量，单位为百分点；仅在选定时的相同问题、平台、语言、原问法及测量条件全部完成后续复测时计算。新增问题不改变进步分母，未知结果不当零。无可比结果显示待复测或待核实。当前差距为参照提及率减自身提及率；追近量比较选定时与复测时的落后部分（领先时取 0），追平后不把扩大领先继续称为追近。选定快照包含参照身份；名称、别名或入口改变后不混用旧基线。

差距行动通过 `geo-competitor-improve` 打开原有改进任务窗口。最新批次复用已读数据；历史批次先读取并核对原项目、批次及参照，失败给出提示，切项目或重复点击会取消过期读取。创建任务时服务端验证当前参照并冻结其身份、该题基线、AI 机会与学习证据；任务不会随以后更换参照漂移。方案生成与审核都包含“自身比之前好”和“与参照缩小差距”两项独立验收目标。打开窗口不启动方案或付费搜索。

新观测在下一次读取时参与发现，并在采集完成后统一生成分析；关注与选择使用 POST 结果更新。概览继续通过[小版本检查](overview.md#概览刷新)发现观测、审核及 Target 变化。

源码：[候选](../../../../src/lib/geo/competitor-candidates.ts)、[候选 route](../../../../src/app/api/geo/competitor-candidates/route.ts)、[对照 route](../../../../src/app/api/geo/competitor/route.ts)、[types](../../../../src/lib/geo/competitor-types.ts)、[对照](../../../../src/lib/geo/competitors.ts)、[指标](../../../../src/lib/geo/competitor-metrics.ts)。
