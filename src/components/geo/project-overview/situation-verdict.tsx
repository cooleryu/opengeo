import type { MetricSummary } from '@/lib/geo/overview-metrics';
import type { getResearchMetrics } from '@/lib/geo/research-view';
import { getPlatformName, pct, type PlatformStat } from './overview-format';

type BuildSituationVerdictInput = {
  sourceOnly: boolean;
  isEn: boolean;
  officialMetrics: ReturnType<typeof getResearchMetrics>;
  mention: MetricSummary;
  topLeaderNames: string;
  brandSplit: { yes: number; total: number };
  discoverySplit: { yes: number; total: number };
  brandLabel: string;
  strongestPlatform: PlatformStat | null;
  weakestPlatform: PlatformStat | null;
  citation: MetricSummary;
};

export function buildSituationVerdict({
  sourceOnly,
  isEn,
  officialMetrics,
  mention,
  topLeaderNames,
  brandSplit,
  discoverySplit,
  brandLabel,
  strongestPlatform,
  weakestPlatform,
  citation,
}: BuildSituationVerdictInput) {
  if (sourceOnly) {
    return {
      headline: isEn
        ? `${officialMetrics.found}/${officialMetrics.completed} web search checks included your site`
        : `网页搜索出现 ${officialMetrics.found}/${officialMetrics.completed} 次`,
      subline: isEn
        ? 'Switch to All or an AI answer engine to inspect mention and citation gaps.'
        : '切换到「全部」或 AI 回答平台查看完整提及与外部引用缺口。',
    };
  }
  if (mention.completed === 0) {
    return {
      headline: isEn ? 'Waiting for first completed measurements' : '等待首轮实测完成',
      subline: isEn
        ? 'Run local browser checks to build your real citation baseline.'
        : '运行本地浏览器实测后，这里会直接给出局势判断与高权重引用缺口。',
    };
  }
  if (mention.yes === 0) {
    const headline = topLeaderNames ? (
      isEn ? (
        <>
          Not yet in AI recommendations — <span data-i18n-skip="">{topLeaderNames}</span> lead
        </>
      ) : (
        <>
          当前在 AI 推荐中未上榜 — <span data-i18n-skip="">{topLeaderNames}</span> 领跑
        </>
      )
    ) : isEn ? (
      'Not yet appearing in AI answers'
    ) : (
      '当前在 AI 回答中暂未出现提及'
    );
    const subline =
      brandSplit.total > 0 && brandSplit.yes === 0 ? (
        isEn ? (
          <>
            The gap is presence: 0/{discoverySplit.total} non-branded answers mentioned you, and even direct &ldquo;<span data-i18n-skip="">{brandLabel}</span>&rdquo; searches missed. Start with the AI-cited lists below.
          </>
        ) : (
          <>
            核心瓶颈是「缺席」：{discoverySplit.total} 次非品牌拉新回答全部未提及，连直接搜「<span data-i18n-skip="">{brandLabel}</span>」也未认出。优先抢占下方 AI 高频引用的外部榜单。
          </>
        )
      ) : isEn ? (
        `The gap is presence: 0/${mention.completed} measured answers name you yet. Start by getting listed on the AI-cited sources below.`
      ) : (
        `核心瓶颈是「缺席」：${mention.completed} 次实测回答暂未出现你的名字，建议优先拿下下方 AI 正在引用的外部榜单与对比页。`
      );
    return { headline, subline };
  }
  if (discoverySplit.total > 0 && discoverySplit.yes === 0) {
    return {
      headline: isEn ? (
        `Visible on brand searches only — 0/${discoverySplit.total} non-branded answers`
      ) : (
        <>
          仅搜「<span data-i18n-skip="">{brandLabel}</span>」时出现 — 非品牌回答仍为 0/{discoverySplit.total}
        </>
      ),
      subline: isEn
        ? 'Buyers who already know your name can find you, but category discovery still goes to competitors. Prioritize external lists and comparisons.'
        : '已经认识你的用户能搜到你，但按需求找工具的新买家全流向了竞品；优先铺设外部榜单和品类对比。',
    };
  }
  const rate = mention.rate ?? 0;
  const engineHint =
    strongestPlatform && weakestPlatform
      ? isEn
        ? ` Strongest on ${getPlatformName(strongestPlatform.engine, true)} (${pct(strongestPlatform.rate)}), weakest on ${getPlatformName(weakestPlatform.engine, true)} (${pct(weakestPlatform.rate)}).`
        : ` ${getPlatformName(strongestPlatform.engine)}表现最强（${pct(strongestPlatform.rate)}），${getPlatformName(weakestPlatform.engine)}最弱（${pct(weakestPlatform.rate)}）。`
      : '';
  if (rate < 50) {
    return {
      headline: isEn
        ? `Appearing in ${mention.yes}/${mention.completed} answers (${pct(rate)}) — not yet the default choice`
        : `已在部分回答中露面（${mention.yes}/${mention.completed}，${pct(rate)}）— 距默认首选还有差距`,
      subline: isEn
        ? `Your site is cited in ${citation.yes}/${citation.completed} answers.${engineHint} Close the top external list gaps below to raise presence.`
        : `官网/仓库直接引用为 ${citation.yes}/${citation.completed}。${engineHint}继续补齐下方外部高频榜单可稳定拉升曝光。`,
    };
  }
  return {
    headline: isEn
      ? `Strong AI presence (${mention.yes}/${mention.completed}, ${pct(rate)})`
      : `已进入核心推荐位（${mention.yes}/${mention.completed}，${pct(rate)}）`,
    subline: isEn
      ? `Site cited: ${citation.yes}/${citation.completed}.${engineHint}`
      : `官网/仓库直接引用 ${citation.yes}/${citation.completed}。${engineHint}`,
  };
}
