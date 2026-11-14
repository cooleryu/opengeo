export type ProjectDraftDocument = {
  label: string;
  filename?: string;
  content: string;
  partial: boolean;
};

/** A reading view of the saved manuscript. The original remains available unchanged. */
export function projectDraftDocuments(source: string): ProjectDraftDocument[] {
  const text = source.replace(/\r\n/g, '\n');
  const replacements = [...text.matchAll(/^## (README(?:\.[\w-]+)?\.md)[：:][^\n]*替换[^\n]*$/gm)];
  if (replacements.length) {
    const documents = new Map<string, string[]>();
    for (const [index, heading] of replacements.entries()) {
      const section = text.slice(heading.index! + heading[0].length, replacements[index + 1]?.index).trim();
      // Only separate the explicitly marked editing instruction, never arbitrary prose.
      const markedBody = /【正文开始】([\s\S]*?)【正文结束】/.exec(section);
      const content = (markedBody?.[1] ?? section.replace(/^边界：[^\n]*\n\n/, '')).trim();
      const blocks = documents.get(heading[1]) ?? [];
      blocks.push(content);
      documents.set(heading[1], blocks);
    }
    return [...documents].map(([filename, blocks]) => ({
      label: filename === 'README.md' ? '中文' : filename === 'README.en.md' ? 'English' : filename,
      filename,
      content: blocks.join('\n\n---\n\n'),
      partial: true,
    }));
  }

  const markedArticle = /【(教程|推广)正文开始】([\s\S]*?)【\1正文结束】/.exec(text);
  if (markedArticle) {
    return [{
      label: '正文',
      filename: /拟新增文件：\s*([^。\n]+\.md)/.exec(text.slice(0, markedArticle.index))?.[1],
      content: markedArticle[2].trim(),
      partial: false,
    }];
  }

  const article = /^# (?!#).+$/m.exec(text);
  if (article) {
    const instructions = /^## [^\n]+\.md[：:]\s*链接插入稿\s*$/m.exec(text.slice(article.index));
    const filename = /建议新建\s*`([^`\n]+\.md)`/.exec(text.slice(0, article.index))?.[1];
    return [{
      label: '正文',
      filename,
      content: text.slice(article.index, instructions ? article.index + instructions.index : undefined).trim(),
      partial: false,
    }];
  }
  return [{ label: '正文', content: text, partial: false }];
}

export function projectDraftCardCopy(title: string, rationale: string) {
  const article = /《([^》]+)》/.exec(title);
  return {
    kind: article ? (/教程/.test(title) ? '上手教程' : '推广文章') : (/README/i.test(title) ? '项目介绍' : '内容改进'),
    title: article?.[1] ?? (/README\.md.*README\.en\.md/.test(title) ? '完善中英文 README' : title),
    summary: rationale.match(/^[\s\S]*?[。！？](?:[”」])?/)?.[0] ?? rationale,
  };
}
