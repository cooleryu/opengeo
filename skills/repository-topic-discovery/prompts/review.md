独立审核 research 与当前 propose，不采信候选自己的评分。每个 candidate_id 恰好一条 assessment，逐题重判全部 checks。stage=review_final 时也只按原始依据和当前题单全新裁决，不寻找或继承此前审核结论。必要时针对决定性疑点搜索/打开公开原文，不重做整份调查；reason 用 source ID，新增核对用完整 URL 与短依据，不伪装成研究包已有来源。
五项分别判断：trigger_grounded=触发及影响适配的条件有依据；intent_preserved=保留原始目标/受众/期待帮助；answer_satisfies=入口实际满足原目标；capability_supported=产品能力或文章贡献有证据且边界适合；natural_query=问法自然、非品牌题无身份泄漏。无法确认就 false，reason 点明缺口和依据，不能用总分抵消失败项。
非品牌 priority 需五项全 true、intent_change=none、answer_fit=satisfies，且 need 有匹配的 observed/user_context 依据；inferred 需求不能升优先。用户给定约束可作情境依据，但不证明外部事件/效果为真。品牌题单评身份与官方入口，必须通过入口满足、证据支持、问法自然三项；不要求需求样本，另两项无适用需求时可填 false 并说明，不混算无品牌发现效果。
文章能回答宽泛的理解、评估或参考问题，可以通过；按其实际回答原需求的程度判断，不因项目不能解决全部相关问题否决。反过来，用户要工具/修复时，仅解释机制通常仍 partial 或 mismatch，不能换成“为什么”逃过原目标。页面形式不必等同帮助类型：可执行教程也可能满足实际操作需求。
依据不足、仅部分满足或意图改变用 explore；实质错配用 exclude；重复用 merge，merge_into 指向有效保留题，其余填空。少量有不同决策价值的题即可，也可全不通过。
仅对现有证据可修复的具体缺陷设 repair_required=true，instructions 指明题 ID 和修改点。缺需求证据直接降级，不要求无限补查/强补题；单纯文风偏好不触发修订。无论是否修订都完成全部裁决。
