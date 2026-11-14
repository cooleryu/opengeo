# 存储与完整数据链路

[总目录](../OPENGEO-CONTRACTS.md) · [共享协议](shared.md)

项目调查存储更新：2026-11-11；其余按既有接口说明。描述当前代码协议；新增或变更接口时同步维护本页。

旧清单的默认项目：`${DATA_DIR || cwd}/data/db.sqlite`；其他项目及网页创建的项目：同根目录的 `data/projects/<projectId>/db.sqlite`。项目 ID 决定目录，迁移时不要改掉已有默认项目或目录。不是每种数据都存 SQLite。

| 数据 | 实际保存位置 / 更新方式 |
| --- | --- |
| 旧项目资料、已有资产正文、旧问题/发现 | `data/local-projects/projects.json` 清单与本地 JSON（Git 忽略）；旧记录保留，空示例不含个人资料 |
| 网页创建的项目目录与理解摘要 | `data/created-projects/projects.json`；读取状态、用户补充及修订沿用现有项目目录存储 |
| 自动调查的资料与关联 | 当前项目 SQLite `geo_project_research_runs/sources/relations`；保存实际 URL、全文、读取时间、归属、关联及逐字引用，逐次追加；最新批次进入内容资产与后续选题 |
| 题单版本 | SQLite `geo_question_plans`，追加revision |
| 冻结批次、追加观测、研究运行 | `geo_research_batches`、`geo_research_observations`、`geo_research_runs`；老批次/原问法保留 |
| 每日问题计划 | `geo_research_schedules`；与任务自身的 monitor 配置分开 |
| 改进任务、方案/审核/实施/跟测历史 | `geo_tasks.payload` 嵌套完整对象；事件 `geo_task_events`，执行占用 `geo_task_locks` |
| 材料核查、人工事实核查、策略版本 | `geo_governance`、`geo_claim_reviews`、`geo_strategies` |
| 搜索完整请求/返回/失败 | 项目 `geo-evidence/<runId>/` 文件；数据库存引用；请求记录不保存 Authorization header |
| Target / 模型配置 | 项目 `competitor.json` / 应用 `data/geo-settings.json`，兼容 Vane `data/config.json`；不属于研究表 |
| 访问/转化 | 上游 Umami 保存；OpenGEO当前只读，不落查询快照 |
| 回答提及/引用审核 | SQLite `geo_answer_audits` 追加审核版本；`geo_answer_audit_imports` 保留兼容迁移标记；源码不包含本地旧审核记录 |

主要路径：

0. **新建项目调查**：提交公开入口 → 读取和补找资料 → 原文及能力/贡献/需求关联写入项目 SQLite → 当前理解与选题读取；每次成功读取先保存，失败保留 partial 状态及原文。`geo-evidence/onboarding-*/` 是供原文入口查阅的副本，全文读取与选题不依赖人工整理文件。旧独立调查目录只保留历史，不再生产新结果。

1. **问题搜索**：编辑与审核题单 → 明确确认 → 冻结研究批次 → 单题/批量/每日调度 → 同一采集执行器 → 逐题追加观测与费用 → 校验证据并分析、追加回答审核（不适用/缺证据/失败保留 unknown）→ API 附带审核及服务端汇总 → 列表、图表和原文展示；可见概览通过小版本检查更新。
2. **改进后跟测**：问题/缺口创建任务 → 真实基线 → 诊断/方案/独立审核 → 用户接受并登记实施 → 复测 → 比较真实可比结果 → 策略候选 → 验证 → 明确启用。评分通过不等于真实改善。
3. **任务结果回到问题页**：采集结束及 getGeoState 调用 importTaskResearchRuns；使用原批次上下文、原问法精确匹配后追加真实观测，不导入replay、不覆盖旧问法。

`geo_answer_audits` 保存 `seq,project_id,batch_id,observation_key,content,payload,appended_at`。观测键由 `questionId,engine,language,recordedAt,evidencePath` 组成，并与项目、批次及唯一既有观测精确匹配；`evidencePath` 使用观测的 `answerPath ?? evidencePath`。保存相同内容幂等，变更内容追加新序号，不覆盖原文、观测或旧审核。读取按同一观测键取最大 `seq`，再检查仍与批次观测匹配。

兼容迁移按项目/批次/来源记录标记，不替换已有新版；未配置本地资料时，旧审核输入为空。未知结论继续保留。`readAnswerAuditData` 返回审核与最近追加时间，`attachOverviewData` 在响应中生成 `answerAudits/overviewMetrics` 并提升 `batch.updatedAt`；汇总不是另一张持久化表，读取不启动模型分析。新研究执行器以外的历史导入记录，若没有对应审核，指标仍为未知。

源码：[answer-audit-store](../../../src/lib/geo/answer-audit-store.ts)、[overview-data](../../../src/lib/geo/overview-data.ts)、[回答审核与口径](pages/overview.md)。
