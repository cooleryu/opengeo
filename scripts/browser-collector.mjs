import fs from 'node:fs/promises';
import path from 'node:path';

export async function collectBrowserQuestion(task, input) {
  const jitterPause = (minMs, maxMs) =>
    new Promise((resolve) => setTimeout(resolve, minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1))));
  const directory=path.join(input.root,'data','browser-captures');
  const captureFile=path.join(directory,`${input.captureId}.json`);
  try {
    const prior=JSON.parse(await fs.readFile(captureFile,'utf8'));
    if (prior.projectId !== input.projectId || prior.batchId !== input.batchId || prior.questionId !== input.questionId || prior.query !== input.query || prior.engine !== input.engine || prior.language !== input.language) throw new Error('采集编号已对应其他问题。');
    return submitBrowserCapture(input,prior);
  } catch(error) { if(error.code !== 'ENOENT') throw error; }
  const page = task.page('p1');
  console.log('正在浏览器采集这一题…');
  let result;
  let conditions;
  if (input.engine === 'chatgpt') {
    let turnIndex;
    const detectChatGPTBlock = async () => page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasTurnstile = Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"], #cf-turnstile, [data-testid="challenge-stage"]'));
      const hit = text.match(/too many requests|rate limit|unusual activity|verify you are human|just a moment|something went wrong.*try again later/i);
      if (hasTurnstile && !hit) return 'Cloudflare challenge';
      return hit ? hit[0] : '';
    });
    if (!input.resume) {
    const composer='#prompt-textarea, [contenteditable="true"][aria-label*="ChatGPT"], [contenteditable="true"][aria-label="询问 ChatGPT"], textarea[placeholder*="ChatGPT"], textarea[placeholder*="Ask"]';
    await page.goto('https://chatgpt.com/?temporary-chat=true');
    const preBlock = await detectChatGPTBlock();
    if (preBlock) throw new Error(`ChatGPT 触发风控/限流或人工校验（${preBlock}），已主动熔断停止，请勿高频重试，请在当前页人工确认后再使用 --space 恢复。`);
    try {
      await page.waitForSelector(composer, {state:'visible',timeout:30000});
    } catch (waitError) {
      const postBlock = await detectChatGPTBlock();
      if (postBlock) throw new Error(`ChatGPT 触发风控/限流或人工校验（${postBlock}），已主动熔断停止，请勿高频重试，请在当前页人工确认后再使用 --space 恢复。`);
      throw waitError;
    }
    await page.waitForFunction(() => /临时聊天|Temporary Chat|won't appear in history/i.test(document.body.innerText), undefined, {timeout:15000});
    const personal = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.checkVisibility() && /^(个性化|Personalization)$/i.test(b.innerText.trim())));
    if (personal) {
      try {
        await page.click('text=/^(个性化|Personalization)$/i');
        await page.click('text=/不个性化|Without memory|Turn off|Off/i', { timeout: 5000 });
        await page.waitForFunction(() => /不会使用记忆|without memory/i.test(document.body.innerText) ||
          [...document.querySelectorAll('button')].some(b => b.checkVisibility() && /^(不个性化|Without memory|Off)$/i.test(b.innerText.trim())), undefined, { timeout: 8000 });
      } catch {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    conditions=await page.evaluate(readChatGPTConditions,{language:input.language,temporaryChatVerified:true});
    turnIndex=await page.evaluate(({query}) => [...document.querySelectorAll('[data-talvt-turn-state]')]
      .filter(turn => turn.querySelector('[data-user-message-bubble]')?.textContent?.trim() === query).length, {query:input.query});
    if (input.humanPause) await jitterPause(1200, 2600);
    await page.fill(composer, input.query);
    if (input.humanPause) await jitterPause(700, 1500);
    await page.click('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送"]');
    if (input.humanPause) await jitterPause(1500, 2500);
    }
    if (!(await page.url()).startsWith('https://chatgpt.com/')) throw new Error('当前页面不是 ChatGPT，不能继续采集。');
    if (input.resume) conditions=await page.evaluate(readChatGPTConditions,{language:input.language,resume:true});
    console.log('等待当前问题的 ChatGPT 回答完成…');
    const selectedTurn=await waitForChatGPTAnswer(page,{query:input.query,turnIndex});
    if (input.humanPause) await jitterPause(900, 1800);
    result = await page.evaluate(extractChatGPT,selectedTurn);
  } else {
    if (!input.resume) {
      if (input.humanPause) {
        const homeUrl = input.language === 'en' ? 'https://www.google.com/?hl=en' : 'https://www.google.com/';
        await page.goto(homeUrl);
        const homeBlocked = await page.evaluate(() =>
          Boolean(globalThis.location?.href?.includes('/sorry/'))
          || Boolean(document.querySelector('iframe[src*="recaptcha"], #captcha-form, form[action*="sorry"]'))
          || /unusual traffic|异常流量|不是自动程序/.test(document.body?.innerText || ''));
        if (homeBlocked) throw new Error('Google 需要人工验证，未写入失败搜索为零值。请在当前页完成验证。');
        try {
          const boxSelector = 'textarea[name="q"]';
          await page.waitForSelector(boxSelector, { state: 'visible', timeout: 15000 });
          await jitterPause(900, 1800);
          await page.fill(boxSelector, input.query);
          await jitterPause(500, 1100);
          await page.keyboard.press('Enter');
          await page.waitForURL((url) => url.pathname === '/search' || url.pathname.startsWith('/sorry'), { timeout: 30000 });
        } catch (navErr) {
          if (/人工验证/.test(navErr?.message ?? '')) throw navErr;
          await page.goto(`https://www.google.com/search?q=${encodeURIComponent(input.query)}${input.language === 'en' ? '&hl=en' : ''}`);
        }
      } else {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(input.query)}${input.language === 'en' ? '&hl=en' : ''}`);
      }
    }
    await page.waitForFunction(() => Boolean(
      document.querySelector('#search')
      || globalThis.location?.href?.includes('/sorry/')
      || document.querySelector('iframe[src*="recaptcha"], #captcha-form, form[action*="sorry"]')
      || /unusual traffic|异常流量|不是自动程序/i.test(document.body?.innerText || '')
    ), undefined, {timeout:30000});
    const blocked = await page.evaluate(() =>
      Boolean(globalThis.location?.href?.includes('/sorry/'))
      || Boolean(document.querySelector('iframe[src*="recaptcha"], #captcha-form, form[action*="sorry"]'))
      || /unusual traffic|异常流量|不是自动程序/.test(document.body?.innerText || ''));
    if (blocked) throw new Error('Google 需要人工验证，未写入失败搜索为零值。请在当前页完成验证。');
    // Unthrottle background tab visibility/paint without stealing OS window focus,
    // then wait for the observed AI Overview turn to finish.
    if (typeof page.cdp === 'function') {
      await page.cdp('Page.bringToFront').catch(() => {});
      await page.cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    }
    await page.waitForFunction(() => {
      const headings=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(h=>/^(AI Overview|AI 概览|AI 概述)$/.test(h.textContent?.trim() ?? ''));
      const heading=headings.find(h=>h.closest('[data-scope-id="turn"]')) ?? headings[0];
      const isGenerating=(root=document)=>[...root.querySelectorAll('[role="progressbar"]')].some(e=>e.checkVisibility() && /generating|生成/i.test(e.getAttribute('aria-label') ?? ''));
      if (!heading) return !isGenerating();
      const turn=heading.closest('[data-scope-id="turn"]');
      if (!turn || isGenerating(turn) || !turn.querySelector('[data-container-id="main-col"]')?.innerText?.trim()) return false;
      const state=turn.getAttribute('data-complete');
      if (state === 'true') return true;
      if (state !== null) return false;
      return [...turn.querySelectorAll('button[aria-label], [role="button"][aria-label]')].some(el =>
        el.checkVisibility() && /^(Good response|Bad response|Copy text|满意|不满意|回答不错|回答不好|复制文本)$/i.test(el.getAttribute('aria-label')?.trim() ?? ''));
    }, undefined, {timeout:120000});
    if (input.humanPause) await jitterPause(900, 1800);
    result = await page.evaluate(extractGoogle,{query:input.query});
    conditions = {mode:result.entryType === 'web_answer' ? 'ai_overview' : 'web_search',region:'unknown',loginState:'unknown',
      searchMode:'Google 默认搜索页',resultLanguage:input.language,notes:result.note};
  }
  if (!result.answerText?.trim()) throw new Error('没有取得完整的可读回答，未提交空结果。');
  const payload = {projectId:input.projectId,batchId:input.batchId,questionId:input.questionId,
    query:input.query,language:input.language,engine:input.engine,captureId:input.captureId,
    recordedAt:new Date().toISOString(),pageUrl:await page.url(),entryType:result.entryType,
    answerText:result.answerText,sources:result.sources,answerComplete:result.answerComplete,
    ...(result.citations ? {citations:result.citations} : {}),
    citationsComplete:result.citationsComplete,citationSource:result.citationSource ?? 'none',
    conditions,raw:{collector:'browser-question',...result}};
  // Recoverable local copy before sending; normal operation immediately submits
  // the same capture to the app, rather than ending with a report file.
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  await fs.writeFile(captureFile,JSON.stringify(payload,null,2),{mode:0o600,flag:'wx'});
  return submitBrowserCapture(input, payload);
}

export function readChatGPTConditions({language,resume=false,temporaryChatVerified=false}) {
  const controls=[...document.querySelectorAll('button,[role="button"]')]
    .filter(button => button.checkVisibility() && !button.closest('[data-talvt-turn-state]'));
  const label=button => `${button.getAttribute('aria-label') ?? ''} ${button.innerText ?? ''}`.trim();
  const temporary=temporaryChatVerified || controls.some(button =>
    /临时聊天|temporary chat/i.test(label(button)) &&
    (button.getAttribute('aria-pressed') === 'true' || /关闭临时聊天|turn off temporary chat/i.test(label(button))));
  const notPersonalized=controls.some(button => button.innerText.trim() === '不个性化');
  const signedOut=controls.some(button => /^(登录|Log in|Sign in)$/i.test(button.innerText.trim()));
  const model=controls.find(button => button.getAttribute('aria-label') === '选择 ChatGPT 模型')?.innerText ?? '未显示';
  return {mode:temporary ? 'temporary_chat' : 'unknown',region:'unknown',loginState:signedOut ? 'signed_out' : 'unknown',model,
    searchMode:'ChatGPT 网页回答',resultLanguage:language,
    notes:[resume ? '继续采集；以下仅为当前可见状态，发送时条件未核实。' : '已在发送前核对页面条件。',
      temporary ? '页面显示临时聊天。' : '是否临时聊天未核实。',
      notPersonalized ? '页面显示不个性化。' : '是否不个性化未核实。',
      signedOut ? '页面显示登录入口。' : '登录状态未核实。'].join('')};
}

export async function waitForChatGPTAnswer(page, {query,turnIndex} = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('等待 ChatGPT 回答需要原问题。');
  if (turnIndex === undefined) {
    turnIndex=await page.evaluate(({query}) => [...document.querySelectorAll('[data-talvt-turn-state]')]
      .filter(turn => turn.querySelector('[data-user-message-bubble]')?.textContent?.trim() === query).length - 1, {query});
    if (turnIndex < 0) throw new Error('当前页面没有与原问题匹配的轮次，不能继续采集。');
  }
  const selectedTurn={query,turnIndex};
  for (const [render, timeout] of [[false, 600000], [true, 10000]]) {
    try {
      await page.waitForFunction(({render,query,turnIndex}) => {
        const turn=[...document.querySelectorAll('[data-talvt-turn-state]')]
          .filter(item => item.querySelector('[data-user-message-bubble]')?.textContent?.trim() === query)[turnIndex];
        const text=turn?.querySelector('[data-markdown-text-style="assistant-message"]')?.textContent?.trim() ?? '';
        const generating=Boolean(document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]'));
        const failed=Boolean(turn?.querySelector('[data-dil-render-failed]')) ||
          /^(无法加载此回复|Unable to load this response|Something went wrong)(?:[。.!\s]|$)/i.test(text);
        return failed || (!generating && turn?.getAttribute('data-talvt-turn-state') === 'complete' && (!render || Boolean(text)));
      }, {...selectedTurn,render}, {timeout});
    } catch (error) {
      if (render && (error.name === 'TimeoutError' || /timed out/i.test(error.message))) {
        throw new Error('回复已完成，但正文在 10 秒内仍未显示；停止采集，保留当前页面。', {cause:error});
      }
      throw error;
    }
    const failed=await page.evaluate(({query,turnIndex}) => {
      const turn=[...document.querySelectorAll('[data-talvt-turn-state]')]
        .filter(item => item.querySelector('[data-user-message-bubble]')?.textContent?.trim() === query)[turnIndex];
      const text=turn?.querySelector('[data-markdown-text-style="assistant-message"]')?.textContent?.trim() ?? '';
      return Boolean(turn?.querySelector('[data-dil-render-failed]')) ||
        /^(无法加载此回复|Unable to load this response|Something went wrong)(?:[。.!\s]|$)/i.test(text);
    },selectedTurn);
    if (failed) throw new Error('ChatGPT 未能显示这条回复，停止等待并保留当前页面。');
  }
  return selectedTurn;
}

export async function submitBrowserCapture(input, payload) {
  const directory=path.join(input.root,'data','browser-captures');
  const captureFile=path.join(directory,`${payload.captureId}.json`);
  console.log('回答已采集，正在自动分析并保存…');
  const response=await fetch(`${input.base}/api/geo/browser-observations`,{
    method:'POST',headers:{'Content-Type':'application/json',Origin:input.base},body:JSON.stringify(payload),
    signal:AbortSignal.timeout(300000),
  });
  const saved=await response.json();
  if (!response.ok) throw new Error(`入库未完成：${saved.error ?? response.status}。原文已保存在 ${captureFile}，可直接重试入库，无需重搜。`);
  await fs.writeFile(path.join(directory,`${payload.captureId}.result.json`),JSON.stringify(saved,null,2),{mode:0o600});
  console.log(JSON.stringify({captureId:payload.captureId,status:saved.status,analysis:saved.audit?.analysisStatus,
    model:saved.audit?.analysisModel,reasoning:saved.audit?.reasoningEffort,
    mention:saved.audit?.mention,citation:saved.audit?.citation,
    overview:saved.batch?.overviewMetrics?.[`${payload.language}:${payload.engine}`]},null,2));
  if (saved.audit?.analysisStatus === 'failed') throw new Error('回答已入库，但模型分析失败；判断保留待核实，可重试分析。');
  if (saved.status === 'needs_review' || saved.audit?.analysisStatus === 'needs_review') throw new Error('回答已入库，但审核仍待核实；请核对证据后再结束采集。');
  return saved;
}

export function extractChatGPT({query,turnIndex,nativeCitationEvidence}) {
  const matching=[...document.querySelectorAll('[data-talvt-turn-state]')]
    .filter(turn => turn.querySelector('[data-user-message-bubble]')?.textContent?.trim() === query);
  const turn=turnIndex === undefined ? matching.at(-1) : matching[turnIndex];
  if (!turn || turn.getAttribute('data-talvt-turn-state') !== 'complete') throw new Error('ChatGPT 回答尚未完成。');
  const user=turn.querySelector('[data-user-message-bubble]');
  if (user?.textContent?.trim() !== query) throw new Error('当前回答与原问题不匹配，停止采集。');
  const reply=turn.querySelector('[data-markdown-text-style="assistant-message"]');
  if (!reply) throw new Error('ChatGPT 回答布局已变化，无法确认回答边界；停止采集。');
  if (turn.querySelector('[data-dil-render-failed]') || /^(无法加载此回复|Unable to load this response|Something went wrong)(?:[。.!\s]|$)/i.test(reply.textContent?.trim() ?? '')) throw new Error('ChatGPT 未能显示这条回复，未将错误提示入库。');
  if (!reply.textContent?.trim()) throw new Error('回答正文为空，停止采集。');
  if (nativeCitationEvidence && (nativeCitationEvidence.pageUrl !== document.location.href || nativeCitationEvidence.query !== query)) {
    throw new Error('原生引用证据与当前页面或问题不匹配，停止采集。');
  }
  // Keep this function self-contained: it is also evaluated inside the browser.
  const safeSource=source=>{
    if (!source || typeof source.title !== 'string' || source.title.length > 4000 ||
      typeof source.url !== 'string' || source.url.length > 16000 || /\s/.test(source.url)) return null;
    try {
      const u=new URL(source.url);
      const secretKey=/^(?:authorization|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;
      if (!['http:','https:'].includes(u.protocol) || u.username || u.password ||
        /(^|\.)chatgpt\.com$/i.test(u.hostname) || [...u.searchParams.keys()].some(key=>secretKey.test(key))) return null;
      return {title:source.title.trim() || u.hostname,url:u.href};
    } catch { return null; }
  };
  const unique=items=>[...new Map(items.map(item=>[item.url,item])).values()];
  const sources=[...reply.querySelectorAll('a[href]')]
    .filter(a=>!/\s/.test(a.getAttribute('href') ?? ''))
    .map(a=>safeSource({title:a.textContent?.trim() ?? '',url:a.href})).filter(Boolean);
  const markers=[...reply.querySelectorAll('[data-d-component="popover-trigger"][role="button"]')]
    .filter(marker=>marker.checkVisibility() && marker.querySelector('[data-d-component="badge"]'))
    .map((marker,markerIndex)=>{
      const label=marker.textContent?.trim() ?? '';
      const extra=label.match(/\+(\d+)$/);
      return {markerIndex,label,expectedCount:extra ? Number(extra[1])+1 : 1};
    });
  const groups=Array.isArray(nativeCitationEvidence?.groups) ? nativeCitationEvidence.groups : [];
  const verifiedGroups=[];
  let citationsComplete=markers.length > 0 && groups.length === markers.length;
  groups.forEach((group,index)=>{
    const marker=Number.isSafeInteger(group?.markerIndex) ? markers[group.markerIndex] : null;
    const duplicate=groups.filter(candidate=>candidate?.markerIndex === group?.markerIndex).length !== 1;
    if (!marker || duplicate || group.label !== marker.label || group.expectedCount !== marker.expectedCount ||
      !Number.isSafeInteger(marker.expectedCount) || marker.expectedCount < 1 || !Array.isArray(group.sources)) {
      citationsComplete=false;
      return;
    }
    const checkedSources=group.sources.map(safeSource).filter(Boolean);
    if (group.markerIndex !== index || group.sources.length !== marker.expectedCount ||
      checkedSources.length !== marker.expectedCount || unique(checkedSources).length !== marker.expectedCount) citationsComplete=false;
    verifiedGroups.push({...marker,sources:checkedSources});
  });
  const citations=unique(verifiedGroups.flatMap(group=>group.sources));
  const citationSource=citations.length ? 'native' : 'unknown';
  return {entryType:'web_answer',answerText:reply.innerText,sources:unique(sources),citations,
    answerComplete:true,citationsComplete,citationSource,
    ...(nativeCitationEvidence ? {nativeCitationEvidence:{pageUrl:document.location.href,query,turnIndex:matching.indexOf(turn),markers,groups:verifiedGroups}} : {}),
    note:citationsComplete ? '完整回答正文；已逐组核对原生引用标记、来源数量及链接。' :
      citationSource === 'native' ? '完整回答正文；已保留核实的原生引用，但引用清单尚未核实完整。' :
        '完整回答正文；正文外链已保留，但未核实原生引用标记，引用判断保留待核实。'};
}

export function extractGoogle({query}) {
  const url=new URL(document.location.href);
  if (!/(^|\.)google\.[a-z.]+$/.test(url.hostname) || url.pathname !== '/search' || url.searchParams.get('udm') === '50') throw new Error('当前页面不是 Google 默认搜索页。');
  const current=document.querySelector('textarea[name="q"],input[name="q"]')?.value;
  if (current?.trim() !== query) throw new Error('Google 当前问题与原问题不匹配，停止采集。');
  // AI Overview's verified turn and main column exclude the organic results.
  const headings=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(h=>/^(AI Overview|AI 概览|AI 概述)$/.test(h.textContent?.trim() ?? ''));
  const heading=headings.find(h=>h.closest('[data-scope-id="turn"]')) ?? headings[0];
  if (heading) {
    const turn=heading.closest('[data-scope-id="turn"]');
    const state=turn?.getAttribute('data-complete') ?? null;
    const hasFinishedFooter=Boolean(turn) && state === null && [...turn.querySelectorAll('button[aria-label], [role="button"][aria-label]')].some(el =>
      el.checkVisibility() && /^(Good response|Bad response|Copy text|满意|不满意|回答不错|回答不好|复制文本)$/i.test(el.getAttribute('aria-label')?.trim() ?? ''));
    if (!turn || (state !== 'true' && !hasFinishedFooter)) throw new Error('Google AI 概览尚未完成，或回答边界已变化。');
    const body=turn.querySelector('[data-container-id="main-col"]');
    if (!body?.innerText?.trim()) throw new Error('Google AI 概览正文为空，停止采集。');
    if ([...turn.querySelectorAll('[role="progressbar"]')].some(e=>e.checkVisibility() && /generating|生成/i.test(e.getAttribute('aria-label') ?? ''))) throw new Error('Google AI 概览仍在生成。');
    const panel=turn.querySelector('[data-container-id="rhs-col"]');
    const sourceRegions=[body, panel].filter(Boolean);
    const links=sourceRegions.flatMap(region=>[...region.querySelectorAll('a[href]')]).flatMap(anchor=>{
      try {
        const target=new URL(anchor.href);
        return ['http:','https:'].includes(target.protocol) && !target.username && !target.password
          ? [{anchor,target,source:{title:anchor.getAttribute('aria-label') || anchor.textContent?.trim() || target.hostname,url:target.href}}] : [];
      } catch { return []; }
    });
    const isGoogleLink=target=>/(^|\.)google\.[a-z.]+$/i.test(target.hostname);
    const unique=items=>[...new Map(items.map(item=>[item.url,item])).values()];
    // Only the observed native source panel establishes citation provenance.
    // Body links and Google's unresolved hops never become confirmed citations.
    const citations=unique(links.filter(({anchor,target})=>panel?.contains(anchor) &&
      panel.checkVisibility() && anchor.checkVisibility() && !isGoogleLink(target)).map(({source})=>source));
    const unresolvedCitations=unique(links.filter(({target})=>isGoogleLink(target)).map(({source,target})=>({
      ...source,resolution:'unresolved',
      reason:/^\/(?:goto|url)(?:\/|$)/.test(target.pathname) ? 'google_redirect' : 'google_internal',
    })));
    return {entryType:'web_answer',answerText:body.innerText.trim(),sources:unique(links.map(({source})=>source)),
      citations,unresolvedCitations,answerComplete:true,citationsComplete:false,citationSource:citations.length ? 'native' : 'unknown',
      note:'Google 默认搜索页 AI Overview；仅采集独立回答正文。原生引用仅记录来源侧栏中可核对的外站直链；正文链接另存为来源，Google 跳转与其他内链保留原地址待解析，引用清单未确认完整。'};
  }
  const search=document.querySelector('#search');
  if (!search) throw new Error('未找到 Google 搜索结果。');
  if ([...document.querySelectorAll('[role="progressbar"]')].some(e=>e.checkVisibility() && /generating|生成/i.test(e.getAttribute('aria-label') ?? ''))) throw new Error('Google AI 概览仍在生成。');
  const sources=[...search.querySelectorAll('a[href]:has(h3)')].map(a=>({title:a.querySelector('h3').innerText,url:a.href}));
  return {entryType:'web_search',answerText:search.innerText,sources,answerComplete:false,citationsComplete:false,
    note:'本次默认搜索页未观察到 AI Overview，保存为普通网页结果，不计入 AI 提及率。'};
}
