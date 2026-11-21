export const assetTypeLabel = (type: string, isEn: boolean) =>
  (
    ({
      article: { en: 'Article', zh: '文章' },
      guide: { en: 'Guide', zh: '实用指南' },
      research: { en: 'Research', zh: '研究' },
      homepage: { en: 'Homepage', zh: '项目首页' },
      social_article: { en: 'Social article', zh: '社媒长文' },
      social_post: { en: 'Social post', zh: '社媒发布' },
    }) as Record<string, { en: string; zh: string }>
  )[type]?.[isEn ? 'en' : 'zh'] ?? type;

export const assetStatusLabel = (status: string, isEn: boolean) =>
  (
    ({
      published: { en: 'Published', zh: '已发布' },
      draft: { en: 'Draft', zh: '草稿' },
      archived: { en: 'Archived', zh: '已归档' },
    }) as Record<string, { en: string; zh: string }>
  )[status]?.[isEn ? 'en' : 'zh'] ?? status;

export const shortPath = (path: string) => path.split('/').slice(-2).join('/');
