# 设置

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

公开版说明更新：2026-10-31。描述当前代码协议；新增或变更接口时同步维护本页。

侧栏“设置”直接打开 `/?view=settings`，沿用 OpenGEO 页面布局。旧 `/research` 地址直接跳转到该页。

## OpenGEO 设置接口

配置应用级共用，所有项目读取同一连接；本批观测数量仍按当前项目计算。设置页仅维护分析与改稿 AI 模型连接（`model`）；ChatGPT 网页回答、Google 网页搜索与 AI 概览通过应用内或本地真实浏览器采集，并展示当前批次已保存记录与查看入口，不依赖搜索 API。

| 接口 | 请求与结果 |
| --- | --- |
| GET `/api/geo/settings` | 返回 `model`，含服务商（`gemini\|deepseek\|openai\|custom`）、地址、模型、`configured`、`keyConfigured`、配置来源；不返回 Key。只读取，不调用供应商。 |
| PUT `/api/geo/settings` | `{section:'model', values:{provider?,baseURL?,model?,apiKey?}}`；按模型分区校验允许字段，返回同一公开对象。空或省略 Key 保留原值；换模型服务商/地址必须显式提供对应 Key。保存不发网络请求。 |
| POST `/api/geo/settings/test` | `{section:'model',acknowledgeCost:true}`，只测试已保存的有效模型配置；用户确认后发送一次小请求，可能计费。成功 `{ok:true,message,testedAt}`；失败返回安全的 `error`，不写业务观测。 |

设置保存至 `DATA_DIR/data/geo-settings.json`（未设置 DATA_DIR 则使用应用目录），文件权限 `0600`，原子替换；原 `.env` 不改。字段优先取已保存值，否则继续读取原环境配置；未被修改的连接保留。密钥文件已排除版本控制和容器构建上下文。

拟题、分析、改稿和审核通过 `loadGeoModel()` 在新操作开始时读取设置。已有跟测继续使用冻结的协议与条件，避免修改可比条件。保存或读取到配置不等于连接已验证。

测试有 45 秒总时限，不自动重试；错误不回显 Key 或供应商完整响应。修改为直连需有效配置，不能静默清空原连接。

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

## 原环境配置与兼容边界

没有界面保存值时，OpenGEO 模型仍读取 `OPENGEO_LLM_MODEL`、`OPENGEO_LLM_API_KEY` 与 `OPENGEO_LLM_BASE_URL`。
模型密钥未保存时可从环境变量回退：Gemini=`GEMINI_API_KEY`；DeepSeek=`DEEPSEEK_API_KEY`（模型 `deepseek-flash`，地址 `https://api.deepseek.com`）；自定义 OpenAI 兼容端点使用 `OPENGEO_LLM_MODEL`、`OPENGEO_LLM_API_KEY`、`OPENGEO_LLM_BASE_URL`。
GeoState 中的 `settings.collectionProviders`、`liveSearchConfigured` 不再返回搜索 API 密钥状态。
新设置写入执行同源检查，但本次没有实现远程多用户鉴权，不能推断已具备多用户隔离。
