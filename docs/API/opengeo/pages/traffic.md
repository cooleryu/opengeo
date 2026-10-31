# 流量数据

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

[两个接口共用的查询参数](#两个接口共用的查询参数) · [访问量与来源：GET /api/geo/traffic](#访问量与来源get-apigeotraffic) · [文章转化：GET /api/geo/conversions](#文章转化get-apigeoconversions) · [配置、存储和边界](#配置存储和边界)

页面进入、切项目、选近7/30天、刷新时分别读取 traffic 和 conversions；两块独立成功/失败，无自动轮询。它们读取 Umami，**不从搜索命中推算访问量**。

## 两个接口共用的查询参数

`GET /api/geo/traffic` 和 `GET /api/geo/conversions`：`project` 必填非空；`startDate/endDate` 要么同时省略（近30天），要么同时给 `YYYY-MM-DD` 真实日期；起点不晚于终点，终点不晚于北京时间今天。服务端固定 Asia/Shanghai，今天截止当前时刻，过去日期包含全天。

共用返回：`projectId,provider:'umami',status,range:{startDate,endDate,startAt,endAt,timezone},fetchedAt,error?`。startAt/endAt 为毫秒。请求参数错为 HTTP400、项目未知404；上游失败通常 HTTP200 + `status:error`，`error={code,message}`，code 为 configuration/authorization/upstream/invalid_response/timeout。no-store。

## 访问量与来源：GET /api/geo/traffic

| 字段 | 后端提供 / 前端处理 |
| --- | --- |
| `status` | not_configured/ready/empty/error；只在 ready/empty 显示数字，其他显示“—” |
| `summary` | `{pageviews,visitors}` 或 null；PV与访客数，不是同一个指标 |
| `pages[]` | `{path,visitors}`，按页面访客数排序，最多20条 |
| `referrers[]` | `{referrer,visitors}`，来源域名访客数排序，最多20条 |
| `limit` | 固定20；不是服务端分页游标 |

后台并行读取 Umami stats、path/url metrics、referrer metrics；任一失败则整块 error。不同分组访客数不可相加当全站 UV；空来源/本站不在外部来源表，不能用差额推导直接流量。API没有逐日趋势或AI流量占比字段。

“AI 引荐”标签由前端静态域名表识别，不是后端确认某条 AI 回答带来此访问；不匹配为未知。加载/错误不能展示0。

## 文章转化：GET /api/geo/conversions

后台读取 Umami v3 原生有序漏斗 `article_view → github_click`，窗口30分钟；v2 为 unsupported。不是直接拿两类事件次数相除。

| 字段 | 含义 |
| --- | --- |
| `status` | not_configured/unsupported/ready/empty/error；前端目前只有 ready 显示数值，empty 显示尚无文章事件 |
| `summary` | `{articleVisitors,githubVisitors,conversionRate}` 或 null；第二步须先完成第一步，rate 后台算0–1小数，分母0为null |
| `journeys[]` | `{source,landingPage,entryScope,articleVisitors,githubVisitors,conversionRate}`；最多10组 |
| `entryScope` | tab-30m/page；page 表示当前页的入口连续性有限 |
| `limit,windowMinutes` | 固定10、30 |
| `grouping` | `{rankedBy:'article_events',returnedValues,invalidValues,truncated}`；returnedValues 为上游返回属性值数量，invalidValues 为无法解析的组合数；合法组>10或上游属性值数量≥100时 truncated=true |

外部网站须已发送事件及 `entry_context`（JSON字符串数组 `[source,landingPage,entryScope]`）。后台按文章事件数取前10个合法组合、逐组读取原生漏斗；事件次数只用于选组，不作转化分母。source 缺失/空值的组合被剔除并计入 invalidValues；字符串 `"unknown"` 才按未知来源展示；路径为站内 `/…`。行访客不可相加，分组读取也不是同一事务快照。点击GitHub不等于安装/购买。

## 配置、存储和边界

服务端配置为 `data/umami.json` 或 `OPENGEO_UMAMI_CONFIG_FILE`；环境覆盖 `OPENGEO_UMAMI_URL/TOKEN/WEBSITE_IDS/API_VERSION`。各项目需独立 websiteIds 绑定，无跨项目默认网站。浏览器不接收 token/websiteId/原始上游报文；服务端只读上游，单请求超时10秒。

事件由 Umami 保存；这两个 OpenGEO GET **不保存流量快照到 SQLite，也不写入事件**。本页没有配置保存、事件采集、订单/收入等协议。需按上方环境变量配置自己的 Umami 服务和项目网站绑定；本次公开发布未验证外部账号或事件。

源码：[TrafficPanel](../../../../src/components/geo/TrafficPanel.tsx)、[ConversionPanel](../../../../src/components/geo/ConversionPanel.tsx)、[traffic route](../../../../src/app/api/geo/traffic/route.ts)、[conversions route](../../../../src/app/api/geo/conversions/route.ts)、[traffic-types](../../../../src/lib/geo/traffic-types.ts)、[conversion-types](../../../../src/lib/geo/conversion-types.ts)、[traffic](../../../../src/lib/geo/traffic.ts)、[conversions](../../../../src/lib/geo/conversions.ts)。
