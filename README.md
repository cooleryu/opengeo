<div align="center">
<h1>OpenGEO</h1>
<p>开源、本地运行的 AI 搜索可见性工作台：查看回答与引用，对照竞品，跟踪改进。</p>
<p><a href="#看清回答和引用">功能</a> · <a href="#支持的平台">平台</a> · <a href="#开始使用">开始使用</a> · <a href="README.en.md">English</a></p>
</div>

![OpenGEO 概览：品牌提及、自有内容引用和各平台结果](docs/images/overview.png)

*概览界面 · 演示数据*

品牌提及和自有内容引用分别统计，未测、未知与真实零值分别呈现。每项结果都可以回到具体回答核对依据。

## 看清回答和引用

管理中英问题，搜索后直接查看完整回答、引用网页和历史记录。选一个主要竞品，按同题、同语言、同平台对照。

![OpenGEO 回答详情：实际问法、完整回答与引用网页](docs/images/question-answer.png)

*回答详情 · 演示数据*

## 把发现的缺口变成改进任务

从单题证据生成方案，经独立审核后登记实施，再按保存的条件跟测。由你决定是否实施、是否启用跟测。

![OpenGEO 改进与追踪：单题方案、审核、实施与跟测](docs/images/improvement-tracking.png)

*改进与追踪 · 演示数据*

## 支持的平台

| 平台 | 当前支持 |
| --- | --- |
| DeepSeek 搜索 API | 采集网页搜索结果 |
| 千问 API / 豆包 API | 采集联网回答及供应商返回的引用 |
| ChatGPT / Google 网页 | 展示已保存记录，暂未接入自动采集 |

API 联网回答与消费端 App 的回答可能不同。搜索与分析需要连接相应服务，可能产生费用。

## 开始使用

准备 **Node.js 24** 和 npm：

```sh
git clone https://github.com/cooleryu/opengeo.git
cd opengeo
npm install
cp .env.example .env.local
npm run dev
```

打开 [localhost:4327](http://127.0.0.1:4327)。凭据留空也可浏览两个空示例项目；截图中的演示数据不随安装提供。

接下来：[添加项目资料与连接服务](docs/getting-started.md#中文)。

当前为开发版，支持单题改进；项目整体优化仍在开发。应用不自动发布内容，审核通过不代表流量或转化已经改善。

[接口文档](docs/API/OPENGEO-CONTRACTS.md) · [Agent 说明](skills/README.md) · [问题与建议](https://github.com/cooleryu/opengeo/issues/new)

---

基于 [Vane](https://github.com/ItzCrazyKns/Vane) 构建，保留上游 [MIT 许可证及版权](LICENSE)。方案审核与跟测设计参考了 [GEOFlow](https://github.com/yaojingang/GEOFlow) 的源码研究，相关实现独立完成。

由 [cooleryu](https://github.com/cooleryu) 维护。
