# 存储与完整数据链路

[总目录](../OPENGEO-CONTRACTS.md) · [共享协议](shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

默认项目：`${DATA_DIR || cwd}/data/db.sqlite`；第二个示例项目：同根目录的 `data/projects/example-project-two/db.sqlite`。不是每种数据都存SQLite。

| 数据 | 实际保存位置 / 更新方式 |
| --- | --- |
| 项目资料、已有资产正文、旧问题/发现 | `src/lib/geo/data/example-project.json`、`example-project-two.json`；当前资产目录无正文CRUD |
| 题单版本 | SQLite `geo_question_plans`，追加revision |
| 冻结批次、追加观测、研究运行 | `geo_research_batches`、`geo_research_observations`、`geo_research_runs`；老批次/原问法保留 |
| 每日问题计划 | `geo_research_schedules`；与任务自身的 monitor 配置分开 |
| 改进任务、方案/审核/实施/跟测历史 | `geo_tasks.payload` 嵌套完整对象；事件 `geo_task_events`，执行占用 `geo_task_locks` |
| 材料核查、人工事实核查、策略版本 | `geo_governance`、`geo_claim_reviews`、`geo_strategies` |
| 搜索完整请求/返回/失败 | 项目 `geo-evidence/<runId>/` 文件；数据库存引用；请求记录不保存 Authorization header |
| Target / 模型配置 | 项目 `competitor.json` / 应用 `data/geo-settings.json`，兼容 Vane `data/config.json`；不属于研究表 |
| 访问/转化 | 上游 Umami 保存；OpenGEO当前只读，不落查询快照 |
| 回答提及/引用审核 | SQLite `geo_answer_audits` 追加审核版本；`geo_answer_audit_imports` 保留兼容迁移标记；公开版不包含旧审核记录 |

主要路径：

1. **问题搜索**：编辑与审核题单 → 明确确认 → 冻结研究批次 → 单题/批量/每日调度 → 同一采集执行器 → 逐题追加观测与费用 → 校验证据并分析、追加回答审核（不适用/缺证据/失败保留 unknown）→ API 附带审核及服务端汇总 → 列表、图表和原文展示；可见概览通过小版本检查更新。
2. **改进后跟测**：问题/缺口创建任务 → 真实基线 → 诊断/方案/独立审核 → 用户接受并登记实施 → 复测 → 比较真实可比结果 → 策略候选 → 验证 → 明确启用。评分通过不等于真实改善。
3. **任务结果回到问题页**：采集结束及 getGeoState 调用 importTaskResearchRuns；使用原批次上下文、原问法精确匹配后追加真实观测，不导入replay、不覆盖旧问法。

`geo_answer_audits` 保存 `seq,project_id,batch_id,observation_key,content,payload,appended_at`。观测键由 `questionId,engine,language,recordedAt,evidencePath` 组成，并与项目、批次及唯一既有观测精确匹配；`evidencePath` 使用观测的 `answerPath ?? evidencePath`。保存相同内容幂等，变更内容追加新序号，不覆盖原文、观测或旧审核。读取按同一观测键取最大 `seq`，再检查仍与批次观测匹配。

兼容迁移按项目/批次/来源记录标记，不替换已有新版；公开版的旧审核输入为空。未知结论继续保留。`readAnswerAuditData` 返回审核与最近追加时间，`attachOverviewData` 在响应中生成 `answerAudits/overviewMetrics` 并提升 `batch.updatedAt`；汇总不是另一张持久化表，读取不启动模型分析。新研究执行器以外的历史导入记录，若没有对应审核，指标仍为未知。

源码：[answer-audit-store](../../../src/lib/geo/answer-audit-store.ts)、[overview-data](../../../src/lib/geo/overview-data.ts)、[回答审核与口径](pages/overview.md)。
