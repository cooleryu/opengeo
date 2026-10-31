# 保留的 Vane 基础 API

[总目录](../OPENGEO-CONTRACTS.md) · [共享协议](shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

当前 GEO 路由与新增接口见 [总目录](../OPENGEO-CONTRACTS.md#geo-路由入口)。没有 `/api/config/providers`，实际服务商路径是 `/api/providers`。
配置路由 5 个：`/api/config` GET/POST；`/api/config/setup-complete` POST；`/api/providers` GET/POST；`/api/providers/:id` PATCH/DELETE；`/api/providers/:id/models` POST/DELETE。
Vane 其余基础路由 11 个，保留但不是正式 GEO 侧栏业务协议：

|路由与方法|保留用途|
|---|---|
|POST `/api/chat`|交互聊天/研究，消息、模型、附件与流式回答。|
|POST `/api/search`|Vane 对外搜索问答 API，可流式；不是 GEO 题单采集保存接口。|
|GET `/api/chats`；GET/DELETE `/api/chats/:id`|Vane 聊天列表、聊天详情、删除；与 GEO 历史记录不同。|
|POST `/api/reconnect/:id`|按内存 session 重连回答流。|
|POST `/api/uploads`|multipart 文件上传及向量处理；不是内容资产治理入口。|
|GET `/api/discover`|按主题查询发现/新闻。|
|POST `/api/images`；POST `/api/videos`|媒体搜索。|
|POST `/api/suggestions`|聊天建议生成。|
|POST `/api/weather`|天气组件。|

兼容页面 pathname 包括 `/c/[chatId]`、`/discover`、`/library`；`/research` 现跳转到 OpenGEO 设置。
完整路由来源：`src/app/api/**/route.ts` 的 HTTP 导出；页面来源：`src/app/**/page.tsx`；这些基础 API 未接到正式 GEO 侧栏业务，不在本文展开其聊天内部协议；通用搜索参数见原 [SEARCH.md](../SEARCH.md)。
