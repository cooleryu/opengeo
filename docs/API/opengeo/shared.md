# 共享协议

[总目录](../OPENGEO-CONTRACTS.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

[请求范围](#请求范围) · [共享状态：GET /api/geo](#共享状态get-apigeo) · [共享动作：POST /api/geo](#共享动作post-apigeo) · [错误与状态](#错误与状态) · [刷新与调度](#刷新与调度) · [原回答与证据文件](#原回答与证据文件) · [当前协议边界与维护](#当前协议边界与维护)

## 请求范围

跨页更新的断点另见本页[数据生产与更新审计](#数据生产与更新审计)。

- `project/projectId` 当前为 `example-project` 或 `example-project-two`。前端始终传当前项目；多数 GEO 路由兼容省略后默认 `example-project`，流量/转化及竞品 POST 的要求另列。没有新建/删除项目 API。
- 中文/英文为 `zh/en`；语言是问法/观测语言，不是地区、登录状态或结果语言。平台枚举按各接口定义，不能把消费者网页与 API 回答混成一个入口。
- 页面 URL 的 `view/task/language/engine/batch/question/record/returnTo` 等用于导航，不是 `/api/geo` 都会接受的筛选参数。各页面额外筛选也不自动成为服务端过滤条件。
- 跨项目切换清空旧页面数据和任务选择、重新读取；异步返回必须核对项目并丢弃过期结果。项目由请求级 `AsyncLocalStorage` 绑定；配置服务和调度器仍是应用级。
- 导航保留中英/平台选择；同项目返回列表或竞品时恢复地址中的筛选/定位。`returnTo` 仅接受同源 `/`、同项目及 `assets/competitor/question-plan` 目标。

正式路由和导航真源：[OpenGeoApp](../../../src/components/geo/OpenGeoApp.tsx)、[projects](../../../src/lib/geo/projects.ts)。旧 `questions/monitor` 是有效子视图，不是重定向到新 URL。

## 共享状态：GET /api/geo

请求 `?project=<id>`，成功直接返回 `GeoState`，无 `{data:…}` 外壳。`Cache-Control:no-store`；当前没有分页或全局 schemaVersion。

|GeoState 字段|现有类型/用途|
|---|---|
|`project`|`{id,name,description,siteUrl,repositoryUrl,owner,asOf}`，均 string。|
|`projects`|已登记项目列表 `GeoProject[]`。|
|`assets`|`GeoAsset[]`，包括正文 markdown、公开链接/本地来源路径、证据路径；不是只有摘要。|
|`questions,observations`|旧固定题/历史可见性兼容数据，不等同于最新研究批次题单。|
|`findings,gaps,proposal,monitoringPlan,boundaries`|seed 自带字段；`gaps:any[]`、后两项 `any`，并非完整严格运行时 schema。|
|`latestResearch`|类型可选 `ResearchBatch\|null`，当前组装函数始终赋值；含持久化 `answerAudits` 与服务端 `overviewMetrics`，字段见[概览](pages/overview.md#返回字段与统计口径)。|
|`visibility`|`buildVisibility(seed,questions,tasks)` 派生旧可见性模型。|
|`questionPlan`|当前可编辑题单 `GeoQuestionPlan`，与最新研究批次分开。|
|`tasks`|本项目完整任务数组，包含 events、runs、workflow/history、实施及跟踪配置；补算 `canContinueRevision`。|
|`governanceRecords,claimReviews,strategies`|类型可选数组；当前组装函数返回对应列表。|
|`settings`|见下列字段表，不包含采集 API key 原值。|

`settings.collectionProviders` 为 `{id,label,configured,missing:string[],model:string|null,costNote}[]`，id 为 `deepseek|doubao|qwen`。
`settings.liveSearchConfigured:boolean` 仅指 `DEEPSEEK_API_KEY` 非空，不代表联网、余额或请求成功。
`settings.modelConfigured:boolean`、`modelName:string|null` 是配置存在性判断；`mode` 固定为 `'demo'`，不是本次任务真实/回放模式。
`settings.schedulerRunning:boolean` 来自服务端进程内全局 scheduler 标志，不代表未来一定准时完成。
`questions/observations` 合并 seed、导入数据和符合旧完整固定题约束的 live run；失败/不完整 run 不替换为零命中。
旧观测选取有同入口、固定题、全部完成等条件，不能用这些字段代表所有新研究入口的全部最新记录。
源码：[geo route](../../../src/app/api/geo/route.ts)、[GeoState](../../../src/lib/geo/types.ts)、[getGeoState](../../../src/lib/geo/store.ts)。

## 共享动作：POST /api/geo

```ts
{ action: string, projectId: string, taskId?: string, /* 各动作字段 */ }
```

`Content-Type:application/json`，必须是非数组对象。前端 `act()` 补当前项目和所选 taskId，再合并动作参数。成功通常是 **HTTP 200 + 完整 GeoState**，不是 `{task:…}` 或仅任务 ID；页面用新状态替换旧状态。

目前没有共享的 `GeoAction` 判别联合类型：前后端接受 `string/Record<string,unknown>`，后台逐动作验证。[各页面协议](../OPENGEO-CONTRACTS.md)中的操作表才是各动作的实际输入契约；不能只凭返回类型推断允许提交哪些字段。

任务执行类动作 `start_workflow/investigate/continue_revision/review_plan/run_monitor` 可先返回当前状态、后台继续；`generate_questions` 等待拟题与审核处理结束，`POST /api/geo/research` 等待该次搜索结束再返回 `{run,batch}`。不能一律使用“200=全部完成”的判断。

## 错误与状态

GEO 路由错误通常为 `{error:string}`，没有统一业务 code：400 输入/业务校验；403 不同 Origin；404 项目/记录不存在；409 版本冲突/正在执行；500 其他异常。各分支例外见[对应页面协议](../OPENGEO-CONTRACTS.md)。流量/转化的上游失败可为 **HTTP 200 + status:error**，模型设置接口用 `message`，不得统一按 HTTP 是否成功渲染绿色结果。

GEO POST 若带 Origin，须与请求协议和 Host 一致；不带 Origin 不因此拒绝。此检查不是账户鉴权。不得把本地项目隔离描述成远程多用户权限系统。

## 刷新与调度

页面初始化、项目变化、从浏览器往返缓存恢复时读取共享状态。概览可见时每 10 秒请求 `GET /api/geo/overview-version?project=…`，返回 `{projectId,version:string}`；首次成功响应、版本变化、重新聚焦或恢复可见时才重读完整共享状态。隐藏、离开概览、卸载时停止并取消请求；项目切换丢弃旧响应。小版本路由只读已有数据库序号/运行时间和 Target 文件修改时间，不启动调度器、搜索或模型，详见[概览刷新](pages/overview.md#概览刷新)。

概览不再执行 investigating/monitoring 任务的 3 秒全包轮询；其他页面保留该轮询。搜索和每日计划另有[问题监测](pages/question-monitoring.md)中的刷新逻辑，不是所有页面一直轮询。

**GET /api/geo 不是绝对无副作用的纯读：**会启动服务端调度器、初始化数据，并导入尚未合并的任务研究结果。已由用户开启且到期的计划可能执行收费请求。打开页面本身不会新建收费计划；已有计划的授权继续有效。调度器依赖应用进程运行，不是系统级常驻服务。

## 原回答与证据文件

`GET /api/geo/evidence?project=<id>&path=<已登记引用>` → `{path,content,format}`，format 为 `markdown/json/html/text`。页面按返回格式显示；HTML 作为文本，不执行。正文不在研究详情包里时，用这里读取。

后台只允许当前项目登记过的证据路径，校验解析/真实路径仍在允许目录；不能读取任意本地文件。运行文件 `data/geo-evidence/…` 按当前项目解析，兼容本地材料引用使用另行配置的根目录；公开版没有附带历史工作区引用。未知/不可读材料 404，路径非法 400，其他错误 500。

当前最多返回前 **200,000 个 JS 字符**，无 `truncated/totalLength` 字段，不能保证长文件完整。响应 no-store；部分前端组件展开后缓存。内部会调用 getGeoState 组装白名单，但此路由自身不启动 scheduler。

源码：[evidence route](../../../src/app/api/geo/evidence/route.ts)、[ContentEvidence](../../../src/components/geo/ContentEvidence.tsx)、[scheduler](../../../src/lib/geo/scheduler.ts)。

## 当前协议边界与维护

| 当前事实 | 对接时不能假定什么 |
| --- | --- |
| 多页共享GeoState，概览另有小版本读取路由 | 不存在每页一个完整数据GET，也没有 overview/assets/tasks/history 各自完整的CRUD路由 |
| 只有 QuestionDetail 显式 version=1；共享action尚无联合类型/统一schema | 文档不等于已实现OpenAPI或所有请求都有自动校验 |
| 问题详情图表及概览提及/引用汇总由后端提供；来源、目录、竞品配对仍有前端派生 | 不能宣称所有展示统计已统一为服务端指标接口 |
| 研究采集逐条持久化观测，并尝试生成提及/引用审核；证据不足保存unknown | 不代表自动生成了新的需求依据、资产正文、人工事实核查或问题AI诊断 |
| 缺失/失败/未知与已测未见不同 | 空数组/null/未测不能一律补0；200不等于业务成功 |
| 搜索预算、任务采集预算、诊断模型费用不同 | 新页面DeepSeek搜索上限不覆盖其他模型调用；其他回答入口预留不等于账单实扣 |
| 项目业务数据隔离；模型配置应用级 | 切项目不能宣称也换了一套Key；内部记录的展示层过滤不构成新的权限域 |

修改接口时，同步对应页面协议、涉及的共享协议、请求分支、返回类型和消费组件；新增枚举要定义空值/未知状态、收费触发及兼容行为。文档给出当前契约，未列出的改造不自动获得实施授权。

## 数据生产与更新审计

2026-10-28 更新：研究采集后的回答审核、追加存储、服务端汇总与可见概览的版本刷新已接通；缺证据、失败和未测仍分开，不保证每条新记录都产生确定结论。

- [OpenGeoApp](../../../src/components/geo/OpenGeoApp.tsx) 使用小版本检查发现后台研究、每日计划、另一窗口新增观测/审核及 Target 变更；全包只在首次、版本变化或恢复可见/聚焦时读取。
- 新 `batch` 对象会让概览竞品摘要重读，同批 ID 不变也能更新。详情图表继续按 `batch.updatedAt` 读取；指定历史批次和独立竞品页面仍有各自的读取依赖，不能宣称所有页面已自动刷新。
- [回答审核与汇总](pages/overview.md)的读取过程不运行模型；共享 GET 自身的既有调度行为见上文。页面刷新不新建搜索或收费计划，也不重写历史观测链接。

流量/转化后端本来就是按请求从 Umami 读取，非一次性报告，且不要求把所有外部统计复制到 SQLite。分类域名表、布局、固定枚举也不是应由 AI 反复生成的数据。本轮未请求 Umami，未验证当前账号配置或外部事件完整性。
