# 内容资产

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

## 数据生产与更新审计

来源 URL、引用计数和人工核查记录已有读取与更新链路。公开版的项目材料从两个空配置文件开始，以下内容不会随新搜索自动更新：

| 缺口 | 新数据会遇到什么 | 证据与补齐方向 |
| --- | --- | --- |
| 项目理解、材料刷新未接应用 | 新文章不会进入拟题材料；第三个项目不能只靠提交入口接入。 | [projects.ts](../../../../src/lib/geo/projects.ts#L8)、[seed.ts](../../../../src/lib/geo/seed.ts#L1) 读取两个示例项目 JSON。独立 [run_workflow.py](../../../../skills/repository-topic-discovery/scripts/run_workflow.py#L799) 有调查/拟题/审核，但只产出文件，未接应用入口与材料存储。复用已有能力，接版本化材料导入/刷新。 |
| 新证据未进入下一轮缺口评估 | 新来源、已解决登记不会生成新版承接判断，下一批不自动接续旧核查。 | [research-batch-plan.ts:29](../../../../src/lib/geo/research-batch-plan.ts#L29) 从 concerns 建 gaps；[content-assets.ts:476](../../../../src/lib/geo/content-assets.ts#L476) 展示原 gaps。保存核查会更新关联任务上下文，但不重算问题 answerability/gaps，也不进入下一次拟题输入。需要引用新证据的评估版本与跨批关联。 |

旧批次及审核应保持不变；缺的是新评估和版本交接。搜索发现的新自有 URL 当前只成为未登记来源，不自动变成有正文、可供拟题的资产。

[读取与前端派生](#读取与前端派生) · [保存材料核查](#保存材料核查) · [从资产开始改进 / 核查](#从资产开始改进--核查)

本节核对正式组件 `ContentPanel`，入口 `/?project=<id>&view=assets`。

## 读取与前端派生

| 页面内容 | 实际协议与数据 | 谁负责计算 / 当前限制 |
|---|---|---|
| 自有内容目录 | 从公共 `GET /api/geo?project=<id>` 的 `GeoState.assets` 读取 `GeoAsset[]` | 静态项目种子提供标题、正文、公开 URL、材料路径等；页面没有新增、上传、改写或删除资产的 API。 |
| 来源目录 | 读取 `latestResearch.questions/deferredQuestions[].observations[].sources` | `buildContentWorkspace(data)` 在前端把来源 URL 规范化，与登记资产关联；归属分 `owned/external/unknown`。只纳入消费者 `chatgpt/google` 来源，API 来源仍留在研究记录。 |
| 资产详情 | `GeoAsset` 的 `id,title,type,language,status,publishedAt,publicUrl,sourcePath,summary,markdown,markdownIsExcerpt?,evidencePaths` | 目录标题、现有正文和摘录边界由后端提供；目录分组、标题提取、问题关系、筛选和计数由前端生成。 |
| 引用/搜索次数 | 前端 `ContentItem.counts`：`chatgptCitations,chatgptAnswers,googleResults,googleOtherSources,googleSearches` | ChatGPT 为已保存来源条目及回答数；Google 普通结果需有位置。不是统一的 AI 引用率，也不包含所有平台。 |
| 问题覆盖 | 前端 `coverage[]`、`questions[]`、`recordedMappings[]` | `matchingAssetIds` 是已有编辑映射；`documented/candidate` 是材料关联判断，均不证明回答真的引用、产品已经验证。 |
| 当前缺口 | 由本批研究题 `gaps[]` 生成 `ContentGovernanceItem[]`，ID 为 `<project>:<batch>:<question>:gap:<index>` | 前端分类 `content/evidence/capability/investigate`；历史 `GeoState.gaps` 单独保留，不合入当前缺口。 |
| 核查记录 | 后端 `GeoState.governanceRecords?: AssetGovernanceRecord[]` | 前端按当前项目、批次及 gapId 找记录；任务关联、依据、状态是真实持久化字段。 |

来源：[ContentPanel.tsx:698](../../../../src/components/geo/ContentPanel.tsx#L698)、[content-assets.ts:17](../../../../src/lib/geo/content-assets.ts#L17)、[content-assets.ts:424](../../../../src/lib/geo/content-assets.ts#L424)、[types.ts:75](../../../../src/lib/geo/types.ts#L75)。

筛选参数 `assetTab,assetQuery,assetType,assetGapFilter,assetLevel,assetDomain,assetLimit,assetId,assetUrl,assetGap,assetDetail,assetEngine,assetQuestion,assetProject`，及共享 `language,engine,batch,observationIndex` 是前端地址状态，**不是后端过滤参数**。目录初始展示 24 项，更多项从已加载数据展开，没有服务端分页；支持的来源平台筛选为 ChatGPT/Google。

## 保存材料核查

调用 `POST /api/geo`，JSON：`{ action:"save_asset_governance", projectId, governance }`。这里不要求 `taskId`。

| governance 字段 | 必选/可选及约束 |
|---|---|
| `batchId,questionId,gapId` | 必选；必须属于当前项目的最新研究批次及该题已有 gap。不得从客户端创造缺口原文。 |
| `status` | 可选：`open/investigating/resolved`；缺省保留旧值或 `open`。 |
| `taskIds` | 可选字符串数组，一次最多 20 项；只关联当前项目、相同问题已有任务（无研究上下文的旧任务也可关联）；与旧值合并去重，不能借空数组解除关系。 |
| `evidence` | 可选 `{note:string,url?:string}`；note 非空且 ≤5,000 字，URL 若提供需有效 http(s)、无账号密码；追加依据记录。 |
| `resolution` | 可选字符串 ≤5,000 字；`resolved` 要求已有/本次补充依据至少一条且结论非空。 |

成功 HTTP 200 返回完整 `GeoState`；新增/更新的 `AssetGovernanceRecord` 包含 `id,projectId,batchId,questionId,gapId,gap,status,taskIds,evidence[{id,note,url?,at}],resolution?,updatedAt,history[{at,status,resolution?}]`。

仅未实施且 `researchContext.gapId` 与当前缺口匹配的关联任务会同步 `assetGovernance` 并清除 `researchGapReview`；添加依据或结论还会写 `reviewContextUpdatedAt`，将旧方案降回草稿、`proposal_ready`，后续必须复检。上述需同步的关联任务正在运行时拒绝保存；此分支捕获并包装错误为 `GeoError` 默认 400，因此内部忙碌 409 实际会被转为 400。全部为本地写入，不抓取依据链接，不自动认定材料属实。

来源：[store.ts:411](../../../../src/lib/geo/store.ts#L411)、[asset-governance.ts:5](../../../../src/lib/geo/asset-governance.ts#L5)、[AssetGovernancePanel.tsx:84](../../../../src/components/geo/AssetGovernancePanel.tsx#L84)。

## 从资产开始改进 / 核查

“开始核查”“新建改进任务”先打开新任务表单，再走[改进与追踪的 create_task](improvement-tracking.md#新建与诊断)。材料缺口入口传 `purpose:"investigate_gap",gapId,gap`，以及 `batchId,questionId,language,engine`；选中自有资产时可携带 `targetAssetId`，选中来源时可携带 `sourceUrl`。创建任务只登记原问题和材料，不启动搜索；`keep_and_fill` 可建核查任务，但不能通过 `start_workflow` 启动搜索。

原始材料统一走 [原文接口](../shared.md#原回答与证据文件)。
