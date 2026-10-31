# 历史记录（独立用户入口已移除）

[总目录](../../OPENGEO-CONTRACTS.md) · [共享协议](../shared.md)

核对日期：2026-10-28。描述当前代码协议；新增或变更接口时同步维护本页。

## 数据生产与更新审计

2026-10-28 源码核查：任务运行、审核轮次和事件确实持久化；历史页归类仍是一次性整理。[TaskWorkspace.tsx:25](../../../../src/components/geo/TaskWorkspace.tsx#L25) 只认识四个固定 ID 及写好的来由，没有通用归档字段/动作。新任务完成不会进入此分组，但记录没有丢失。

补齐方向：将已确认的四条来由迁为任务来源/用途字段，提供明确历史状态及操作，页面读取字段。不要把所有失败任务自动藏进历史，也不修改原记录来伪造来由。

用户确认取消独立“历史记录”入口。旧 `view=history` 地址现在改为 `view=tasks` 并清除原任务定位，进入“改进与追踪”；侧栏及概览不再提供历史页入口。

`OpenGeoApp` 在展示层过滤 `TaskWorkspace.isHistoricalTask()` 标识的 4 条内部接入验证、失败尝试和演练记录，避免从任务、内容资产关联或旧任务地址重新展示。原 `GeoState.tasks` 存储及后端接口不变，没有删除记录，也没有新增 `/api/history`、归档 action 或独立历史表。过滤不按“失败”“已完成”等状态判断，真实用户任务的失败仍保留。

真实业务历史继续在对应功能中读取：问题的研究运行、批次、回答与来源通过“问题监测”查看；任务的 `events`、`workflowHistory`、`qualityHistory`、每轮候选/审核及 `runs` 在“改进与追踪”详情中查看。证据仍走 `/api/geo/evidence`。本次不改变其后端状态校验、存储或访问权限。

来源：[TaskWorkspace.tsx](../../../../src/components/geo/TaskWorkspace.tsx)、[OpenGeoApp.tsx](../../../../src/components/geo/OpenGeoApp.tsx)、[VisibilityPanel.tsx](../../../../src/components/geo/VisibilityPanel.tsx)。

任务对象和状态定义统一见[改进与追踪](improvement-tracking.md#返回对象与状态字典)，本页不重复定义。
