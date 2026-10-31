# 设置

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

公开版说明更新：2026-10-31。描述当前代码协议；新增或变更接口时同步维护本页。

侧栏“设置”直接打开 `/?view=settings`，沿用 OpenGEO 页面布局。旧 `/research` 地址跳转到该页，不再经过 Vane 欢迎动画或初始化向导。

## OpenGEO 设置接口

配置应用级共用，所有项目读取同一连接；本批观测数量仍按当前项目计算。设置页区分默认 AI 模型和搜索采集配置。ChatGPT 网页回答、Google 网页搜索展示当前批次已保存记录与查看入口，标明未接自动采集；它们不等于 OpenAI API 或 Gemini 连接。

| 接口 | 请求与结果 |
| --- | --- |
| GET `/api/geo/settings` | 返回 `model` 与 `search`，含服务商、地址、模型、`configured`、`keyConfigured`、配置来源；不返回 Key。只读取，不调用供应商。 |
| PUT `/api/geo/settings` | `{section:'model'\|'deepseek'\|'qwen'\|'doubao', values:{provider?,baseURL?,model?,apiKey?}}`；按分区校验允许字段，返回同一公开对象。空或省略 Key 保留原值；换模型服务商/地址必须显式提供对应 Key。保存不发网络请求。 |
| POST `/api/geo/settings/test` | `{section,acknowledgeCost:true}`，只测试已保存的有效配置；用户确认后发送一次小请求，可能计费。成功 `{ok:true,message,testedAt}`；失败返回安全的 `error`。模型检查结构化结果，搜索检查对应采集响应，不写业务观测。 |

设置保存至 `DATA_DIR/data/geo-settings.json`（未设置 DATA_DIR 则使用应用目录），文件权限 `0600`，原子替换；原 `.env` 不改。字段优先取已保存值，否则继续读取原环境配置；未被修改的连接保留。密钥文件已排除版本控制和容器构建上下文。

拟题、分析、改稿和审核通过 `loadGeoModel()` 在新操作开始时读取设置；搜索 Key 在发送时读取。新搜索/新任务使用保存的采集模型，已有跟测继续使用冻结的模型与协议，避免修改可比条件。保存或读取到配置不等于连接已验证。

测试有 45 秒总时限，不自动重试；错误不回显 Key 或供应商完整响应。既有 Vane provider 配置继续兼容实际调用，但测试按钮会说明该旧连接暂不支持单次测试。修改为直连需有效配置，不能静默清空原连接。

源码：[设置页](../../../../src/components/geo/ConnectionSettingsPanel.tsx)、[设置路由](../../../../src/app/api/geo/settings/route.ts)、[配置读取与保存](../../../../src/lib/geo/connection-settings.ts)、[连接测试](../../../../src/lib/geo/connection-test.ts)。

## 本地 ChatGPT 订阅分析

设置页提供 `Continue with ChatGPT`，使用动态注册和订阅授权，不读取 Codex、浏览器或其他客户端的登录凭证。完成授权并选择模型后，可验证一条已有回答，也可显式启用订阅分析。启用后，回答审核、竞品分析及竞品引用审核使用所选订阅模型与思考强度；未启用时使用 API 分析模型。拟题与改进方案仍沿用 API 模型。搜索服务单独配置；订阅分析失败不会自动转用另一付费供应商。此能力不采集 ChatGPT 网页搜索结果。

| 接口 | 请求与结果 |
| --- | --- |
| GET `/api/geo/chatgpt?project=…` | 本浏览器授权后返回连接状态、账号显示名、所选模型与思考强度、分析开关、可验证的已有回答及最近验证结果；未授权仅返回未连接状态。无模型调用。 |
| POST `/api/geo/chatgpt`，`action:'signin'` | 生成随机待授权 Cookie，返回官方授权地址。独立回调只监听 `127.0.0.1`，校验 state、PKCE、ID Token 签名/身份/nonce 和发起浏览器 Cookie；成功后换发独立的 HttpOnly、SameSite=Strict 本地会话。 |
| 同一路由，`action:'models'` / `action:'model',model,reasoningEffort?` | 读取当前授权账号的模型目录；只允许选目录中的模型及其支持的思考强度。需要已完成授权的浏览器会话。 |
| 同一路由，`action:'auto-analysis',enabled:boolean` | 保存是否在支持的分析步骤使用订阅额度；启用前必须已授权套餐使用并选择模型。此操作本身不分析历史回答。 |
| 同一路由，`action:'analyze',projectId,requestId,acknowledgeUsage:true` | 选一条此前已核实正文和引用采集完整的真实回答，用 OAuth 请求公开 Responses 接口。必填字段和证据通过现有审核后追加保存，并返回安全的模型、usage 与判断依据。重复 requestId 不重发；中断、拒绝或未知状态不伪装成功。 |
| 同一路由，`action:'disconnect'` | 尝试撤销远端刷新会话并清除本地 Token 和浏览器授权；远端撤销未确认时明确说明。 |

凭证在 `DATA_DIR/data/chatgpt-private/connection.json`（默认应用 `data/`），目录 `0700`、文件 `0600`，拒绝符号链接；不放在 `.env`、公开配置、前端存储或 API 响应。Git、Docker 构建上下文及 Next standalone 文件追踪均排除该目录。回调不经过 Next 路由，避免把授权码写入其请求日志。推理关闭 SDK 调试日志，不回显供应商原始异常；请求固定走 `https://api.openai.com/v1/responses`，`store:false`、`stream:true`，只在 `response.completed` 后采纳结果。保护边界是本机操作系统账号及完成授权的浏览器，不是远程多用户托管服务。

真实验证记录仅保存判断和必要运行信息至 `data/chatgpt-analysis-verification.json`，同样不入 Git/构建包；本次公开发布未重新进行登录或真实请求验证。开源代码不包含任意用户的凭证，各安装自行授权。

官方协议：[注册登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[账户与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[推理要求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。

## 兼容保留的 Vane 接口（非当前设置页）

设置组件 `SettingsDialogue` 打开时 GET `/api/config`；设置四组为 preferences、personalization、models、search。
这些路由没有 `project/projectId`，是 Vane 应用全局配置，不能描述为项目隔离配置。
统一风格与 GEO 不同：成功/失败一般 `{message:string}`，服务商新增/修改为 `{provider:…}`，配置 GET 为 `{values,fields}`。

|接口|请求、成功返回、失败/限制|
|---|---|
|GET `/api/config`|无请求字段；200 `{values:Config,fields:UIConfigSections}`；modelProviders 结合当前 provider 模型列表；异常 500 message。|
|POST `/api/config`|body `{key,value}`；两者 truthy 为必需，UI key 为 `组名.字段名`；200 `Config updated successfully.`；缺字段 400；异常含 JSON 解析 500。|
|POST `/api/config/setup-complete`|不读 body；标 setupComplete=true；200 `Setup marked as complete.`；异常 500；并不核验供应商联网能力。|
|GET `/api/providers`|200 `{providers:MinimalProvider[]}`；排除 chatModels 含 key=`error` 的 provider；异常 500。|
|POST `/api/providers`|body `{type,name,config}` truthy 必需；200 `{provider:ConfigModelProvider}`；缺字段400；无效 type/其他异常500。|
|PATCH `/api/providers/:id`|id + body `{name,config}` truthy 必需；200 `{provider:ConfigModelProvider}`；缺字段400；找不到 provider/其他异常500。|
|DELETE `/api/providers/:id`|无 body；200 `Provider deleted successfully.`；缺 id400；未找到 id 的实现直接成功；异常500。|
|POST `/api/providers/:id/models`|body `{key,name,type:'chat'\|'embedding'}`；仅 key/name 做必填检查；200 `Model added successfully`；缺字段400；无效 provider/其他异常500。|
|DELETE `/api/providers/:id/models`|body `{key,type:'chat'\|'embedding'}`；仅 key 做必填检查；200 的 message 仍写 `Model added successfully`；缺 key400；异常500。|

`Config` 为 `{version,setupComplete,preferences,personalization,modelProviders,search}`；`ConfigModelProvider` 为 `{id,name,type,chatModels,embeddingModels,config,hash}`。
`MinimalProvider` 只含 `{id,name,chatModels,embeddingModels}`；`Model` 为 `{name,key}`；模型 type 未在 route 做运行时 enum 校验，非 chat 分支进入 embedding。
`fields` 描述 `{name,key,type,required,description,scope,env?,default?,…}`；scope 为 client/server，select 有 options。
client 字段写 localStorage：theme 默认 dark、measureUnit 默认 Metric、autoMediaSearch/showWeatherWidget/showNewsWidget 默认 true、systemInstructions 默认空。
server 的 search 仅 SearXNG URL，key=`search.searxngURL`，初始默认空，可由 `SEARXNG_API_URL` 初始化；POST 因 truthy 校验无法保存空串清空。
聊天/embedding 模型选择只写 localStorage 的 `chatModelProviderId/chatModelKey/embeddingModelProviderId/embeddingModelKey` 并更新 ChatProvider。
新增/修改 provider 的 config 字段由对应 provider 的 fields 定义，默认值来自 fields；API 没有通用字段级完整校验。
模型列表读取失败可回退为 `{key:'error',name:错误消息}`，新增/修改仍可能 200；因此保存成功不等于可用性验证通过。

## 原环境配置与兼容边界

没有界面保存值时，OpenGEO 模型仍读取 `OPENGEO_LLM_MODEL`，并要求 `OPENGEO_LLM_API_KEY` 或 `OPENGEO_VANE_PROVIDER_ID` 存在；可用 `OPENGEO_LLM_BASE_URL`。
尚未在新设置页保存模型且设置了 `OPENGEO_VANE_PROVIDER_ID` 时，服务端继续用 Vane registry 的对应 provider；否则构造兼容 OpenAI 的模型连接。
旧 Vane 聊天模型选择不会改变 OpenGEO 设置；新的配置保存通过上方 `/api/geo/settings` 接入实际调用。
采集密钥未保存时从环境回退：DeepSeek=`DEEPSEEK_API_KEY`；豆包=`ARK_API_KEY || DOUBAO_API_KEY`；千问=`DASHSCOPE_API_KEY || QWEN_API_KEY`。
采集模型环境项为 `OPENGEO_DOUBAO_MODEL`、`OPENGEO_QWEN_MODEL`；默认分别为 `doubao-seed-2-0-lite-260428`、`qwen-plus-2025-07-14`。
任务冻结 `CollectionConfig` 含 provider/endpoint/model/parameters/metric，不含 credentials；GeoState 只给配置状态。
Vane configManager 将配置（含 provider config）序列化到本地 `data/config.json`，环境导入的 provider config 也可能写入此文件。
但遗留 GET `/api/config` 与 provider POST/PATCH 响应没有密钥脱敏，`config` 原值会返回浏览器；新的 OpenGEO 设置页不调用这些接口，但本次没有重构或移除其兼容能力。
遗留 route 也未见用户鉴权/同源显式检查；新设置写入执行同源检查，但本次没有实现远程多用户鉴权，不能推断已具备多用户隔离。

源码：[config 路由](../../../../src/app/api/config/route.ts)、[providers 路由](../../../../src/app/api/providers/route.ts)、[配置类型](../../../../src/lib/config/types.ts)、[configManager](../../../../src/lib/config/index.ts)、[模型 registry](../../../../src/lib/models/registry.ts)、[OpenGEO planner](../../../../src/lib/geo/planner.ts)。
