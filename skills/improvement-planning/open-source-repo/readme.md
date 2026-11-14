---
id: improvement-planning/open-source-repo/readme
tab: 改进与追踪
scenario: open-source-repo
role: writer
title: 开源代码仓库 README 门面规范
---

# 本篇文体：开源代码仓库 GitHub README 门面改写

本篇写给**第一次点进你 GitHub 仓库的人类访客（独立开发者、产品负责人、小团队运营）**以及**读取仓库首页的 AI 搜索引擎**看。
行文风格借鉴 `yetone/magpie` 开源仓库：**默认首页 `README.md` 为英文（右上导航提供 `[简体中文](README.zh-CN.md)`），配套中文页为 `README.zh-CN.md`（顶部提供 `[English](README.md)`，并链接至 `docs/getting-started.zh-CN.md`）——首屏克制自信、先立价值与适用边界、快速开始足够轻巧、功能用截图和短表说话、隐私与费用坦诚、同名区分轻描淡写收在最末页脚**。

## `targetLanguage = "en"` 英文门面硬规范
- 全篇 `title` 与正文必须 **100% 使用地道、干练的开发者英语（0 汉字）**。
- 居中首屏保留干净的品牌 Logo：<p align="center"><img src="docs/images/opengeo-logo.png" width="80" height="80" alt="OpenGEO" /></p>。
- **严禁嵌入任何中文界面截图**（`docs/images/overview.png`、`docs/images/question-answer.png`、`docs/images/improvement-tracking.png`）；用清晰的英文 Markdown 对比表（如平台采集方式表、与只做监测的工具差异表）与 `flowchart LR` Mermaid 闭环图替代截图。
- **差异化定位**（克制客观、绝不拉踩）：点清无论是按月付费的商业 SaaS（如 Otterly.AI、Profound、Peec AI），还是偏重追踪跑分的开源监测器（如 Elmo、Gego、Limelit Open），重点多停留在看可见度数字或引用列表；OpenGEO 则打通“本地真实浏览器采集原文与引用 → 自动拆解外部被引用赢家页骨架 → 直接起草并三红线审核可采用改稿 → 同题复测”。

## 绝对不可犯的错误（踩中直接不合格！）

1. **绝不在门面正文里抱怨“AI 搜我们名字会搜出别人”**：读者已经点进你的仓库了，如果在开头大段写“现在在 ChatGPT 里搜 XXX 多半会介绍别人/同名仓库，省得你走错门……”，会让人感觉极其别扭且不自信！同名项目无隶属关系的澄清**只能作为全篇最末尾一行冷静小字**（例如中文：`OpenGEO 维护于 github.com/cooleryu/opengeo，与 Pupok462/open-geo、opengeo.work、同名浏览器插件及 OSGeo OpenGeo Suite 无隶属关系。`；英文：`OpenGEO is maintained at github.com/cooleryu/opengeo and is not affiliated with Pupok462/open-geo, opengeo.work, the OpenGEO browser extension, or OSGeo OpenGeo Suite.`），在正文前部专心自信地讲清你是什么、解决什么问题即可。
2. **绝不引用 `public/icon.png` / `icon-50.png` 等旧图标**：英文版仅可保留 `docs/images/opengeo-logo.png` 并配合英文表格/Mermaid 图；中文版再使用 `availableMedia` 里的真实中文界面截图。
3. **绝不摆出命令行安装块吓跑人**：`Node.js 24`、`git clone`、`npm install`、`cp .env.example`、`localhost:4327` 一律不能出现在门面正文里。

## 必须遵循的页面骨架（按此顺序组织全文）

### 第 1 块：居中品牌首屏（`<div align="center">`）
严格使用以下简洁优雅的居中结构（保留锚点导航，英文版 `README.md` 与中文版 `README.zh-CN.md` 保持一一对应，避免使用旧的 `README.en.md`）：

- **若 `targetLanguage = "en"`**：在 `<div align="center">` 顶部放置 `<p align="center"><img src="docs/images/opengeo-logo.png" width="80" height="80" alt="OpenGEO" /></p>`，全部标题/简介/锚点用英文，末尾导航加 `[简体中文](README.zh-CN.md)`，并**省略**下方的 `docs/images/overview.png`（绝不在英文门面嵌中文界面截图）。
- **仅当 `targetLanguage = "zh"` 时**，才在居中块下方紧跟 1 张中文主界面实拍图 `docs/images/overview.png`：

```markdown
<div align="center">

# OpenGEO

### 一句锋利好懂核心定位（不超过 22 字，例如：看清 AI 搜索怎么回答你的产品，把缺口直接改成好内容。）

**一句具象的日常困扰场景（例如：ChatGPT 推荐了竞品没提你、DeepSeek 说错了你的功能、回答底下没挂你的官网。）**<br>
两行以内讲透本地闭环：把真实客户问题跑一遍，存下完整回答和参考网页，<br>
查到短板直接写出配套改稿，挑合适的上线后再用原题复查变化。

**[适合你吗](#opengeo-适合你吗)** · **[快速开始](#快速开始)** · **[整体流程](#整体流程)** · **[功能](#功能)** · **[文档](#文档)** · **[隐私与费用](#隐私与费用)** · **[English](README.md)**

</div>

<!-- 仅中文版 (targetLanguage = "zh") 嵌入此中文截图；英文版禁止嵌入 overview.png -->
![主界面概览图注（来自 availableMedia 真实路径）](docs/images/overview.png)

*概览界面 · 演示数据（实际结果取决于你的项目与已测试平台）*
```

### 第 2 块：`## OpenGEO 适合你吗？`
- 用 1 段短话点清为什么市面上常见“黑盒可见度分数”帮不到具体改网页的人。
- 用 3~4 条加粗要点概括不可替代之处（例如：**每条结论都能点回原始回答核对**、**直接写好配套改稿而非空泛建议**、**按篇单独采用，不绑架全发**、**数据、提问与密钥全留在自己电脑上**）。
- **末尾补一段坦诚的“不适合谁”**（学习 `magpie` 的克制与可信度）：说明如果你只需要每天全自动定时扫上百个词看趋势周报、不想自己连接口或手工补录网页回答，市面上按月付费的线上监测服务更省心；如果你更在意看清 AI 到底引了谁的网页、想自己掌握数据并直接把改稿做出来，它正合适。

### 第 3 块：`## 快速开始`
用清爽的 **`1 · 启动工作台` → `2 · 创建项目与提问清单` → `3 · 查看回答、挑出改稿并复测`** 三步带过，全程不写半句终端命令：
- **`1 · 启动工作台`**：把仓库地址 `https://github.com/cooleryu/opengeo` 发给你常用的 AI 编程助手（Claude Code、Cursor、Codex、Antigravity 等），直接让它按仓库里的说明帮你在本地启动并打开页面；想自己动手或看完整界面说明，直接进 [快速上手文档](docs/getting-started.md)。
- **`2 · 创建项目与提问清单`**：选好你的项目类型，贴入公开主页链接和几句补充说明，系统会自动读懂产品并准备好客户常问问题。
- **`3 · 采回答、挑改稿、再复测`**：跑完问题看清哪几道漏了你，逐篇审阅配套改稿并只采用觉得对路的那几篇，发布上线后过阵子再拿原题重测看变化。

### 第 4 块：`## 整体流程`
用 2 句话说明工作台怎么连成闭环，配 1 张清爽的 Mermaid 流程图（`flowchart LR` 或 `TD`，4~6 个节点，大白话）。

### 第 5 块：`## 功能`（`## Features`）
分 3 个清晰小节：
- **问题监测与原文留证**：讲清原始提问、AI 完整回答、参考网页与竞品同题对照（仅在 `targetLanguage = "zh"` 且有真实中文截图时嵌入 `docs/images/question-answer.png`；英文版改用紧致结构化说明或对比表）。
- **赢家拆解、配套改稿与单篇采用**：讲清怎么先自动拆解被引用赢家页面的标题结构与切入逻辑，再生成带改前改后对照的互补方案、三红线把关，按自己节奏逐篇采用再原题重测（中文版可嵌 `docs/images/improvement-tracking.png`）。
- **支持的平台**：放一张诚实直观的 2~3 列表格，分清 **ChatGPT / Google AI Overviews**（在用户自己的本地浏览器会话中按人性化低频节奏整批采集真实回答与引用来源，也支持无痕手工保存原文核对；触发 Google 人机验证时交由用户确认）与 **DeepSeek / 千问 / 豆包**（可选填入自己的 API 密钥一键联网提问留证）。

### 第 6 块：`## 文档`（`## Documentation`）
放一张干净的二列导航表，保留原有有效链接：[快速上手](docs/getting-started.zh-CN.md)（英文首页用 `docs/getting-started.md`）、[接口文档](docs/API/OPENGEO-CONTRACTS.md)、[Agent 提示词说明](skills/README.md)、[English README](README.md)（英文首页链接 `[简体中文 README](README.zh-CN.md)`）。

### 第 7 块：`## 隐私与费用`（`## Privacy & Cost`）
用坦诚直接的话说明：项目数据、回答截图和接口密钥只保存在你自己的电脑里；浏览已有记录不花钱，只在你主动发起联网提问、生成方案或复测时向你选定的模型服务商发起请求并产生对应费用。

### 第 8 块：`## 反馈与维护` + 末尾一行同名声明
- 保留 [问题与建议](https://github.com/cooleryu/opengeo/issues/new) 与 `由 [cooleryu](https://github.com/cooleryu) 维护。`（英文：`Maintained by [cooleryu](https://github.com/cooleryu).`）
- **全篇最后一行**放冷静极简的实体区分小字：
  - 中文：`OpenGEO 维护于 github.com/cooleryu/opengeo，与 Pupok462/open-geo、opengeo.work、同名 Chrome 插件及 OSGeo OpenGeo Suite 无隶属关系。`
  - 英文：`OpenGEO is maintained at github.com/cooleryu/opengeo and is not affiliated with Pupok462/open-geo, opengeo.work, the OpenGEO browser extension, or OSGeo OpenGeo Suite.`
