import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectDraftDocuments, projectDraftCardCopy } from './project-draft-preview';

test('bilingual README replacements become separate readable documents without losing body text', () => {
  const documents = projectDraftDocuments([
    '以下是内部修改说明。',
    '## README.md：替换首屏\n\n边界：首屏替换为：\n\n<div><h1>项目</h1><p>介绍</p></div>',
    '## README.md：替换开始使用\n\n边界：安装段落替换为：\n\n## 开始使用\n\n```sh\nnpm install\n```',
    '## README.en.md：替换首屏\n\n边界：首屏替换为：\n\n# Project\n\nIntroduction.',
    '## README.en.md：替换开始使用\n\n边界：安装段落替换为：\n\n## Quick start\n\nRun locally.',
  ].join('\n\n'));
  assert.equal(documents.length, 2);
  assert.deepEqual(documents.map((item) => item.label), ['中文', 'English']);
  assert.equal(documents[0].content, '<div><h1>项目</h1><p>介绍</p></div>\n\n---\n\n## 开始使用\n\n```sh\nnpm install\n```');
  assert.equal(documents[1].content, '# Project\n\nIntroduction.\n\n---\n\n## Quick start\n\nRun locally.');
  assert.ok(documents.every((item) => item.partial));
});

test('article reader separates the complete article from implementation instructions', () => {
  const body = '# 第一次使用\n\n正文。\n\n## 下一步\n\n更多内容。';
  const [document] = projectDraftDocuments(`建议新建 \`docs/first-check.md\`。\n\n${body}\n\n## docs/getting-started.md：链接插入稿\n\n插入位置说明。`);
  assert.equal(document.content, body);
  assert.equal(document.filename, 'docs/first-check.md');
  assert.equal(document.partial, false);
});

test('unrecognized draft formats keep their complete content', () => {
  const source = '没有标题的稿件。\n\n仍然需要展示全部内容。';
  assert.equal(projectDraftDocuments(source)[0].content, source);
});

test('explicit manuscript boundaries keep handoff notes out of README and article previews', () => {
  const source = [
    '【交接边界，不属于 README 正文】\n请保留其他区块。',
    '## README.md：首屏替换稿\n\n替换范围：首屏。\n【正文开始】\n# 项目\n\n介绍。\n【正文结束】',
    '## README.md：开始使用替换稿\n\n【正文开始】\n## 开始使用\n\n安装。\n【正文结束】',
    '## README.en.md：Quick start 替换稿\n\n【正文开始】\n## Quick start\n\nInstall.\n【正文结束】',
  ].join('\n\n');
  const documents = projectDraftDocuments(source);
  assert.deepEqual(documents.map(item => item.label), ['中文', 'English']);
  assert.equal(documents[0].content, '# 项目\n\n介绍。\n\n---\n\n## 开始使用\n\n安装。');
  assert.equal(documents[1].content, '## Quick start\n\nInstall.');

  for (const kind of ['教程', '推广']) {
    const [article] = projectDraftDocuments(`拟新增文件：docs/guide.md。\n【${kind}正文开始】\n# 跟着做\n\n完整正文。\n【${kind}正文结束】\n【配套入口插入稿，不属于教程正文】\n内部交接。`);
    assert.equal(article.content, '# 跟着做\n\n完整正文。');
    assert.equal(article.filename, 'docs/guide.md');
  }
});

test('draft cards emphasize the article title and first stated reason', () => {
  assert.deepEqual(projectDraftCardCopy('写一篇上手教程：《第一次用 OpenGEO》', '帮新用户完成首次检查。更多细节。'), {
    kind: '上手教程', title: '第一次用 OpenGEO', summary: '帮新用户完成首次检查。',
  });
  assert.equal(projectDraftCardCopy('写首次使用教程《第一次用 OpenGEO》，并为指南补入口', '').title, '第一次用 OpenGEO');
});
