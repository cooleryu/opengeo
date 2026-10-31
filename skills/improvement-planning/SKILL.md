---
name: improvement-planning
description: 为 OpenGEO 的改进与跟踪生成搜索诊断、具体改进方案，并通过独立审核和修订形成可供用户审阅的候选。
---

# 改进方案

所属功能：改进与跟踪。

这组文件承接本轮保存的搜索证据、原始需求、目标材料和历史策略。它负责提出改进方案并独立审核，不执行搜索、发布或实施。审核通过只表示方案值得尝试，真实效果仍需实施后按相同条件跟测。

## 阶段文件

- [common.md](common.md)：各阶段共用的真实性、来源和材料信任边界。
- [diagnose.md](diagnose.md)：搜索诊断，区分观测、原因假设与未知。
- [propose.md](propose.md)：根据诊断提出具体改进方案。
- [review.md](review.md)：独立审核完整诊断与候选稿，不接收写作者会话或上一轮评分。
- [repair.md](repair.md)：依据上一轮审核逐项修订，保留原目标与替换范围。
- [proposal-requirements.md](proposal-requirements.md)：方案生成与修订共用的候选稿要求。

运行时仅在执行对应阶段时读取 `common.md` 和该阶段提示；生成与修订另读 `proposal-requirements.md`。本说明文件不会整体发送给模型。

## 参数

[parameters.json](parameters.json) 保存各阶段的 `temperature`、`maxTokens` 和默认质量循环次数 `defaultMaxQualityRounds`。任务已有的 `maxQualityRounds` 优先于文件默认值；质量循环的既有硬上限仍由代码约束。预览采用默认轮数，用户编辑后的复检仍只审核一次，继续修订仍使用该次操作明确传入的追加轮数。

模型与推理配置继续使用 OpenGEO 现有设置。输出结构、证据与原文核对、质量门槛和停止条件由代码校验，不因本组文件调整而改变。
