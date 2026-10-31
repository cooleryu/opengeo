# 独立执行与计时

这是运行在应用之外的真实命令行流程。Python 负责阶段调度、数据校验、超时、停止条件与报告；每个调查、生成和审核阶段使用独立的本机 Codex 会话。用户只需提供 GitHub 仓库 URL，不需要自行整理产品材料。

前提：Python 3.9+、已可正常调用的 `codex` CLI。沿用调用者当前模型配置，不覆盖模型或推理档位。模型调用消耗已有账号额度；没有新增付费搜索提供商。若环境限制 Codex 初始化或联网，需要按运行环境的正常权限流程处理，脚本不会绕过权限或降成不受控运行。

每阶段在临时空目录启动独立进程，使用只读沙箱和仅对该进程生效的精简配置；不修改全局设置、不复制登录凭证。调查和审核启用公开网页检索，生成和修订仅消费输入材料；关闭本任务不需要的记忆、技能目录、应用、终端、浏览器和委派工具。`topic-lean-v2` 另通过 `features.code_mode.excluded_tool_namespaces` 排除内嵌的文件修改、资源读取与时钟工具；保留承载网页工具所需的执行通道。外层 `functions.exec/wait` 是单列计量的残留，不能称为零工具包装。实际配置与 CLI 版本写入阶段的 `runtime.json`，并用拒绝式本地请求捕获检查实际声明，不能只凭配置宣称已生效。

从 OpenGEO 仓库根目录运行单项目：

```sh
python3 skills/repository-topic-discovery/scripts/run_workflow.py \
  --repo https://github.com/OWNER/REPOSITORY
```

两个项目并行运行与输出目录：

```sh
python3 skills/repository-topic-discovery/scripts/run_workflow.py \
  --repo https://github.com/OWNER/REPOSITORY_A \
  --repo https://github.com/OWNER/REPOSITORY_B \
  --output data/topic-runs/my-topic-run \
  --workers 2
```

`--output` 省略时生成独立日期目录；已存在目录会拒绝覆盖。`--dry-run` 只产生执行清单，不调用模型。`--context context.json` 可传入会话里已经得到的目标、地区或场景，JSON 以规范仓库 URL 为键；它是可选信息，不向用户索取新的材料清单。提供的提醒必须标为用户输入，不能作为 Agent 自主发现的成果。

## 固定阶段

1. `research`：读仓库和少量相关内容，调查触发场景与原始需求；保留引用、访问完整性及不确定性。
2. `propose`：仅使用研究包出题，记录原意图、预期帮助、实际帮助和剩余缺口。
3. `review`：新会话独立审核，必要时读取决定性原文。判断触发、意图保持、实际满足、证据和问法自然性。
4. 若需要具体修复，执行一次 `repair`，再用全新会话执行 `review_final`。第二位审核上下文不读取前一审核的结论，只接收研究包和修订题单。
5. `render`：由程序生成结果和计时，不再次调用模型写长报告。

固定角色提示词在 `prompts/`，三个严格输出契约在 `schemas/`。每阶段仅加载 `common.md`、本阶段提示（复审复用 `review.md`）及下表的前序材料，不加载整份 `SKILL.md` 或质量参考。输入还包含仓库 URL、用户已有上下文和当前 UTC 时间。

| 阶段 | 前序材料 |
| --- | --- |
| research | 无 |
| propose | research |
| review | research + propose |
| repair | research + propose + review |
| review_final | research + 修订后的 propose；不含旧题单或旧审核 |

JSON 紧凑传递，研究包中的原始需求、必要来源片段和能力限制完整保留。精简针对重复规则与无关历史，不降低证据要求。[quality-gates.md](quality-gates.md) 仅供人工执行或维护时澄清难判的语义边界。新项目无需临时编写派工词；每阶段保存实际提示、Schema、原始返回与校验后结果。

## 输入和交接的硬边界

预算单位均为 **UTF-8 字节，不是 token**：`user_context` 最多 4 KiB，完整阶段业务提示最多 48 KiB；超过任一上限，保存完整输入与指标后明确停止，不静默删减证据。自动注入和工具返回不属于这两个业务材料限额，另用实际请求及服务端用量审计。

每项目返回和合并 `HANDOFF.md` 各最多 8 KiB。超限时保留完整本地文件，交接降为状态、审核/失败/未决项与文件位置；完整材料见 `timings.json`、`final.json` 和 `HANDOFF.full.md`。异常摘要最多 1 KiB，完整错误见 `error.txt`。`return-metrics.json`、`handoff-metrics.json` 记录前后字节数及是否降级。主 Agent 默认只读短交接，发生争议时按指针查具体依据。

`--dry-run` 同样检查输入预算，只打印状态和清单位置，不回显整份用户上下文。配置或 CLI 变化后，可运行 `scripts/capture_runtime.py --prompt 阶段/prompt.txt --schema 阶段/schema.json --stage propose --output 新目录 --fail-on-unexpected`；网页阶段也单独检查。它只在本机回环接收并拒绝请求，不调用模型；严格检查通过不代替一次真实网页工具可用性验证。

## 交付门槛与停止

程序要求来源、触发和需求 ID 有效，审核恰好覆盖所有候选；修订保持原候选 ID，合并必须有有效保留目标。优先题需独立审核全部通过、原始需求没有被偷换、实际帮助被评为满足。品牌题单列；没有需求样本不阻止身份检查，但不能豁免身份与内容证据。

结构校验不能证明内容为真，语义判断仍由调查与独立审核完成。文章可以满足宽泛的理解或评估需求，教程可能满足实际操作需求；按原始目标与实际帮助判断，不要求产品解决所有相关问题。单纯解释不能冒充工具解决方案，基于假设的人群/需求也不能直接按已验证机会交付。

默认单阶段最多 240 秒、单项目最多 600 秒，可以用 `--stage-timeout`、`--project-timeout` 调整。最多一次修订；检索围绕关键疑点，在时间预算内无新依据就停，不设必须完成的搜索配额，不强制补齐题数。证据不足直接探索或排除。运行失败、无效 JSON、引用错误或超时会停止该项目并保存失败，不无限重试；另一并行项目可继续。修订上限耗尽仍有问题时保留未满足状态，不能靠标记完成伪装审核通过。

## 实际留下什么

- 根目录 `run.json`：输入、配置、启动时间、流程条件。
- 根目录 `timings.json`、`SUMMARY.md`：项目结果及真实总墙钟时间；并行耗时不相加。
- 每个仓库 `research/`、`propose/`、`review/` 及条件性修订目录：实际提示、`prompt-metrics.json`、输出契约、调用配置、模型事件日志、错误日志、返回与阶段计时。
- 各阶段及项目/根目录 `usage.json`：实际服务端报告用量及汇总，失败调用也记录；未报告保持未知。提示字符/字节估算不含运行时规则、schema、工具定义与内部轮次，不能冒充真实输入 token。
- 每个仓库 `final.json`、`REPORT.md`：程序应用门槛后的题单和可读结果；失败项目保留已完成材料。`HANDOFF.md` 提供简短结论与证据路径，不再展开所有阶段全文。

计时使用单调时钟测耗时，同时记录 UTC 起止。阶段耗时包含该阶段启动、联网、生成和校验；总运行耗时包含并行等待和最终汇总，不包含一次性开发及运行结束后的人类比较。报告生成自身计时以 `timings.json` 为准。

对旧版的时间比较必须说明旧时间是否实测、输入是否增加提示、模型和检索条件是否一致。少量定向运行不能推出稳定加速比；题目变长、加热点词、或搜到自己更多都不自动等于题目更好。

## 恢复已调查但未输出的研究阶段

若研究超时，且原运行有唯一持久化会话 ID、相同仓库与 user_context、尚无有效研究包，可在原命令上添加 `--recover-research-from 原运行目录`，并指定一个不存在的新 `--output` 目录。恢复阶段关闭网页，只整理会话已经读过的依据；后续出题和审核仍是独立新会话。可显式设置 `--stage-timeout 360 --project-timeout 900`，不要修改旧证据来伪装成功。

恢复不是冷启动，必须计入此前取得材料的成本。CLI 恢复 usage 可能为会话累计量，运行器在恢复前保存最新基线，保留 raw_server_usage 并差分得到新增量；版本或计数无法确认就标未知，不能重复相加。权限与必需的 `code_mode_host` 执行通道保留；关闭无关工具不等于关闭其承载通道。

## 最小验证

```sh
python3 skills/repository-topic-discovery/scripts/test_workflow.py
```

离线测试检查停止、超时、引用、修订上限与交付门槛；不把模拟后端当成真实调查结果。CLI 执行方式参考 [OpenAI 非交互运行说明](https://learn.chatgpt.com/docs/non-interactive-mode) 与 [结构化审核修订示例](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex)。
