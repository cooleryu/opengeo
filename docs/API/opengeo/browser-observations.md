# 浏览器逐题采集

## 当前接线与验证

2026-11-08 恢复后实测：继续读取此前已生成的同一条 ChatGPT 临时聊天回答，未重新提问。正文与 3 组原生引用（去重后 3 个网页）已保存；Astra Max 识别为同名其他项目，语义审核得到 `mention: no`、`citation: no`，并通过证据检查。已打开的概览通过现有轮询自动读到新判断，无需手动刷新。不同采集条件的新观测不能当作优化前后的效果对比。

本次原生引用弹窗由操作者逐组展开核对，提取器校验页面、问题、标记、来源数量与链接后保存分组证据；49 项采集器测试通过。**单题的采集、自动分析、入库与概览读取已验证；命令自动展开所有原生引用弹窗仍未接通。** 以下加载失败记录保留为排查历史，不代表当前仍未恢复。旧 Google 记录的引用完整性仍为未知，未重复搜索。

浏览器采集命令为 `scripts/browser-collect.mjs`，依赖本机 ego-browser 与可用的浏览器会话，独立于应用内搜索按钮。逐题采集后立即调用保存接口，再由已配置模型分析；概览沿用现有版本轮询读取更新。不会因为用户在任意浏览器手动搜索，就自动监听或读取该页面。

本地已用一条历史 ChatGPT 真实回答验证自动分析、SQLite 保存、重复提交复用和概览自动读取；补录保留原采集时间。

2026-11-08：复用已保存的 Google AI Overview 原文，经 Astra Max 语义复审，确认回答介绍的是同名插件和地理软件，而非目标项目，保存 `identity: excluded`、`mention: no`；原采集时间与观测不变，未重复搜索。概览已读到该判断。引用清单仍未确认完整，`citation: unknown` 保留。原语义审核已支持“不认识该品牌”和同名排除；本次补充的是摘录规则：身份说明依赖相邻品牌标题时，必须一并逐字引用，证据校验未放宽。此前失败的原模型输出没有保存，不能倒推其具体字段。

引用采集目前**部分完成**：接口将普通来源链接与确证原生引用分开；Google 提取可见原生来源侧栏直链，并保留未解析的 Google 跳转链接。旧 Google 页面未保留完整引用面板，无法在不重搜的情况下补齐，仍不声明清单完整。ChatGPT 原生引用适配尚未完成：本次新临时聊天提交一题后显示“无法加载此回复”，重新加载仍失败；刷新后回到空白临时聊天。尝试只读历史回答也出现相同加载失败。因此新题未取得正文、未入库，也没有用历史补录冒充新题闭环通过。没有重复发送问题。

2026-11-08 后续定位：绕开采集脚本，在 ChatGPT 临时聊天手动发送同一道品牌题，仍出现页面原生的 `data-dil-render-failed` 错误。只读重开历史回答也复现。浏览器记录显示回答渲染资源 `https://cdn.platform.openai.com/deployments/dil/v15/runner.html` 在内嵌加载时返回 HTTP 403，响应含 `X-Frame-Options: SAMEORIGIN`，随后触发 `net::ERR_BLOCKED_BY_RESPONSE`；正常直接打开该公开资源则返回 200。直接打开后用页面自带的“重新加载回复”恢复同一回答，内嵌加载仍返回 403。当前可确认故障发生在回答渲染资源加载阶段，不是采集器找不到正文；尚不能断定是平台普遍故障还是当前浏览器/访问环境兼容问题，等待常用浏览器对照。未修改浏览器安全设置或网络配置，未重复搜索 Google；这条失败回答没有入库，也没有作为零值参与概览。

采集器同时修正本题边界：按原问题及同题轮次等待和提取，避免读取旧回复；续采只记录可见条件，不再默认声明已登录或发送时无个性化。待核实结果仍保存，但保留浏览器页面供补齐引用。36 项合成采集测试通过，这不替代尚未完成的新 ChatGPT 真实引用采集与入库验收。

```sh
node scripts/browser-collect.mjs --project PROJECT_ID --question QUESTION_ID --engine chatgpt
```

命令从当前已确认问题读取原问法；采集完成即提交下面的接口，不需要另写报告或手工写数据库。ChatGPT 使用临时聊天且关闭个性化，不保存为历史对话。这不代表服务端绝对零留存；参见 [Temporary Chat 官方说明](https://help.openai.com/en/articles/8914046-temporary-chat-in-chatgpt)。Google 默认搜索页使用 `--engine google`；有 AI 概览时保存 AI 回答，否则只保存网页结果。复用受控浏览器工作区时传 `--space SPACE_ID`；该工作区由调用方负责收尾。采集暂停后，传相同工作区及 `--resume true` 继续读取已生成的回答，不再次提问。

已采到的本地正文保存在 Git 忽略的 `data/browser-captures/`。网络中断时，用 `--saved CAPTURE_ID` 直接提交同一条；模型分析确需重试时，再加 `--retry-analysis true`。普通重复提交复用已有判断，不重复调用模型。

## 入库接口

`POST /api/geo/browser-observations` 保存浏览器原文、追加研究观测，然后等待现有回答审核；不负责浏览器导航或改写问题。只接受本机 `http://127.0.0.1` 的同源 JSON 请求。

请求必填字段：`projectId`、`batchId`、`questionId`、`query`、`language`（`zh` / `en`）、`engine`（`chatgpt` / `google`）、`entryType`（`web_answer` / `web_search`）、`captureId`、`recordedAt`、`pageUrl`、`answerText`、`sources`、`citationSource`、`answerComplete`、`citationsComplete`、`conditions`。`query` 必须逐字匹配该批已确认问题的对应语言原文。

- `web_answer.sources` 只保存这条 AI 回答正文中的链接，或该回答原生引用面板中的链接。不能放入页面导航、其他回答或普通 Google 搜索结果。每条为 `{title, url}`。
- `citations` 以相同结构单列已核对的原生引用。新的采集记录声明 `citationSource: native` 时必须显式传入（可为空），普通正文链接只放 `sources`。模型仅接收 `citations` 中的原生引用；仅已保存且同一 `captureId` 的原始内容完全一致、明确声明 `citationSource: native` 的旧记录，才兼容以 `sources` 作为引用。不能根据链接带有 `utm_source` 就断定是原生引用。
- `web_search.sources` 保存普通网页搜索结果，顺序即页面结果顺序；这类观测不计为 AI 提及或 AI 引用。
- `citationSource` 必填，取 `native`、`unknown` 或 `none`。只有采集器确实核实了上述原生引用来源，才能声明 `native`。未核实填 `unknown`；没有取得引用证据填 `none`。`none` 不表示已经证明 AI 没有引用。
- `citationsComplete` 说明原生引用清单是否完整；`answerComplete` 独立说明正文是否完整。未知来源即使给出链接，也不能据此确认 AI 引用；完整正文仍可用于品牌提及审核。
- Google AI 概览使用 `engine: "google"`、`entryType: "web_answer"` 和 `conditions.mode: "ai_overview"`；普通 Google 搜索另记 `web_search`。
- `conditions` 必须包含 `mode`、`region`、`loginState`（`signed_in` / `signed_out` / `unknown`）；可选 `model`、`searchMode`、`resultLanguage`、`notes`。不知道地区时明确写 `unknown`，不要按查询语言推断。

可选 `raw` 保存不含凭证的结构化采集证据。禁止提交 Cookie、Authorization 或密钥。请求上限为 2 MiB。原始数据写入项目私有目录 `data/geo-evidence/browser-{captureId}/capture.json`，回答正文写入同目录的 `answer.md`；均不覆盖已有证据。

模型输出通过字段结构检查后，在同一私有目录追加 `analysis-时间戳.json`，只保存结构化判断和证据校验失败原因，不保存授权凭证或供应商原始响应。证据未通过的判断仍不能进入已确认指标，保留该文件是为了以后直接排查和复核原回答。

回答详情的证据接口也识别已登记的浏览器 `answer.md`，不再将其误判为缺少正文；仍受当前项目证据白名单约束。本次已用保存的 Google 回答验证接口返回原正文。

返回 `captureId`、`duplicate`、`query`、`originalURL`、`conditions`、`citationSource`、`status`、`retryable`、`run`、`observation`、`audit`、`batch`。其中 `batch` 含已有概览指标；`status` 与 `audit` 表示当前审核结果，原运行记录保留首次处理状态。分析失败或待核实时，不会伪装成完整审核。

`GET /api/geo/browser-observations?projectId=…&captureId=…` 只读取进度和已保存结果，不触发分析。普通重复 POST 复用结果；同一 `captureId` 的不同内容返回冲突。确需重试失败或待核实的分析时，以原请求加 `retryAnalysis: true` 提交；不会再追加相同观测。观测及审核写入现有数据库表，应用原有概览版本轮询可发现更新。
