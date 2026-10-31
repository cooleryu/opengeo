# OpenGEO 前后端协议总目录

按正式侧栏页面查找。每个页面独立维护请求、返回和前端处理；项目范围、共享状态、错误与原文接口只在共享协议维护。公开版说明更新：2026-10-31。文档描述代码接口及已知边界，不代表本次重新验证了供应商、模型质量、定时运行或真实效果。两个项目均为空示例，不包含个人记录。

## 按页面查找

| 页面 | 协议文档 | 主要内容 |
| --- | --- | --- |
| 概览 | [overview](opengeo/pages/overview.md) | 统计口径、数据来源、概览渲染 |
| 问题监测 | [question-monitoring](opengeo/pages/question-monitoring.md) | 题单、批量/单题搜索、每日跟踪、详情与图表、事实核查 |
| 竞品对照 | [competitor](opengeo/pages/competitor.md) | Target 设置、匹配依据、双方对照 |
| 流量数据 | [traffic](opengeo/pages/traffic.md) | 访问来源、Umami、文章转化 |
| 内容资产 | [content-assets](opengeo/pages/content-assets.md) | 资产目录、来源关联、材料核查、发起任务 |
| 改进与追踪 | [improvement-tracking](opengeo/pages/improvement-tracking.md) | 诊断、审核续改、实施、复测、策略、任务对象 |
| 历史记录（独立入口已移除） | [history](opengeo/pages/history.md) | 旧地址兼容、内部记录过滤与业务历史归属 |
| 模型与搜索设置 | [settings](opengeo/pages/settings.md) | 应用级配置、模型与服务商、凭据边界 |

## GEO 路由入口

| 路径 | 方法 | 协议 |
| --- | --- | --- |
| `/api/geo` | GET、POST | [共享状态与动作](opengeo/shared.md) |
| `/api/geo/evidence` | GET | [证据读取](opengeo/shared.md#原回答与证据文件) |
| `/api/geo/research` | GET、POST | [问题监测](opengeo/pages/question-monitoring.md) |
| `/api/geo/research/tracking` | GET、POST | [每日计划](opengeo/pages/question-monitoring.md#每日问题跟踪) |
| `/api/geo/overview-version` | GET | [概览刷新](opengeo/pages/overview.md) |
| `/api/geo/overview-order` | GET、POST | [概览布局](opengeo/pages/overview.md) |
| `/api/geo/competitor` | GET、POST | [竞品设置](opengeo/pages/competitor.md) |
| `/api/geo/competitor-candidates` | GET、POST | [竞品推荐](opengeo/pages/competitor.md) |
| `/api/geo/traffic`、`/api/geo/conversions` | GET | [流量与转化](opengeo/pages/traffic.md) |
| `/api/geo/settings` | GET、PUT | [连接配置](opengeo/pages/settings.md) |
| `/api/geo/settings/test` | POST | [连接测试](opengeo/pages/settings.md) |
| `/api/geo/chatgpt` | GET、POST | [ChatGPT 订阅分析](opengeo/pages/settings.md) |

## 共用部分

- [共享协议](opengeo/shared.md)：项目与语言范围、GeoState、通用动作、错误、调度、原文读取，以及当前协议边界。
- [存储与完整数据链路](opengeo/storage.md)：SQLite 表、配置/原文文件、搜索与任务的数据流向。
- [保留的 Vane 基础 API](opengeo/legacy-api.md)：基础聊天/搜索接口清单，与正式 GEO 页面接口的区别。

## 五环的数据生产是否接通

有读取接口不等于已有持续生产链。下表是当前代码检查，未重新调用模型或搜索，也未做本轮浏览器验收；“已有”不代表模型质量或真实效果已验证。

| 环节 | 已有 | 仍缺什么 / 证据 |
| --- | --- | --- |
| 理解产品 | 独立调查出题脚本；应用读取两个项目配置文件 | [入口调查、材料刷新未接应用](opengeo/pages/content-assets.md#数据生产与更新审计) |
| 确认问题 | 模型拟题、独立审核、人工维护、版本保存与批次确认 | [输入仍为配置材料；候选合并与材料更新尚有限制](opengeo/pages/question-monitoring.md#数据生产与更新审计) |
| 搜索并诊断 | DeepSeek 搜索、Qwen/Doubao 联网回答、原始返回、SQLite 追加、逐条回答审核、服务端提及/引用汇总与概览版本刷新 | [消费端采集、诊断更新](opengeo/pages/question-monitoring.md#数据生产与更新审计)仍未接通；[回答审核](opengeo/pages/overview.md#数据生产与更新审计)缺证据时保留 unknown |
| 方案与独立审核 | 模型诊断、改稿、独立复审、按条件停止、保存各轮 | [新依据对诊断和续改意见的版本约束不完整](opengeo/pages/improvement-tracking.md#数据生产与更新审计) |
| 跟测与学习 | 实施登记、同条件复测、经验候选、验证、启用与回退 | [评分偏差分析、可执行观察窗口未接通](opengeo/pages/improvement-tracking.md#数据生产与更新审计) |

仓库调查尚未接入应用；项目整体优化仍在开发，本次不包含。每日计划已有代码，但本次未按真实时间触发验证。后续仍需处理问题诊断、候选合并及其余页面的刷新依赖，再接材料调查/更新、消费端持续采集和评分偏差学习。回答提及/引用审核及概览刷新已有实现，边界见对应文档；旧证据、人工授权步骤和正常图表计算不是缺陷。

## 修改时看哪里

- 改某个页面：看该页协议及其源码链接，不需要通读所有页面。
- 改共用返回字段或错误约定：改共享协议，并核对受影响页面；不复制多份共用定义。
- 改持久化或跨页数据链路：同步存储文档和相关页面。
- 新增页面：增加一个页面文件，再补本目录链接。页面需要多份协议、示例或截图时，再扩成独立目录。

<details>
<summary>原章节入口（兼容旧链接）</summary>

原文件路径及章节入口保留，正文已迁移。

<a id="11-请求范围"></a>
<a id="12-共享状态get-apigeo"></a>
<a id="13-共享动作post-apigeo"></a>
<a id="14-错误与状态"></a>
<a id="15-刷新与调度"></a>
<a id="16-原回答与证据文件"></a>
### 1. 共享协议

[查看共享协议](opengeo/shared.md)

### 2. 概览

[查看概览](opengeo/pages/overview.md)

<a id="31-题目和题单的编辑"></a>
<a id="32-读取列表详情图表与原文"></a>
<a id="33-单题勾选批量搜索全部"></a>
<a id="34-每日问题跟踪"></a>
<a id="35-源码与落库"></a>
<a id="36-回答里的人工事实核查"></a>
### 3. 问题监测

[查看问题监测](opengeo/pages/question-monitoring.md)

### 4. 竞品对照

[查看竞品对照](opengeo/pages/competitor.md)

<a id="51-两个接口共用的查询参数"></a>
<a id="52-访问量与来源get-apigeotraffic"></a>
<a id="53-文章转化get-apigeoconversions"></a>
<a id="54-配置存储和边界"></a>
### 5. 流量数据

[查看流量数据](opengeo/pages/traffic.md)

<a id="读取与前端派生"></a>
<a id="保存材料核查"></a>
<a id="从资产开始改进--核查"></a>
### 6. 内容资产

[查看内容资产](opengeo/pages/content-assets.md)

<a id="新建与诊断"></a>
<a id="审核手动改稿与自动续改"></a>
<a id="实施登记"></a>
<a id="单次复测与每日任务跟测"></a>
<a id="真实效果与策略学习"></a>
<a id="返回对象与状态字典"></a>
### 7. 改进与追踪

[查看改进与追踪](opengeo/pages/improvement-tracking.md)

### 8. 历史记录（独立入口已移除）

[查看历史记录](opengeo/pages/history.md)

<a id="opengeo-业务模型与密钥的真实边界"></a>
### 9. 模型与搜索设置

[查看模型与搜索设置](opengeo/pages/settings.md)

### 10. 存储与完整数据链路

[查看存储与完整数据链路](opengeo/storage.md)

### 11. 当前协议边界与维护

[查看当前协议边界与维护](opengeo/shared.md#当前协议边界与维护)

### 12. 保留的 Vane 基础 API

[查看保留的 Vane 基础 API](opengeo/legacy-api.md)

</details>
