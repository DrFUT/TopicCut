import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { parseSrt } from '../src/utils/srt.ts';
import { buildClips, extractTerms } from '../src/utils/clips.ts';
import { clampClipRange, suggestFileName } from '../src/services/exportService.ts';
import { toSubtitleSource } from '../src/services/sourceService.ts';
import { sidecarOrigin, subtitleSourceText } from '../src/utils/format.ts';
import type { AiChapter, SubtitleCue } from '../src/types/index.ts';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
}

const file = process.argv[2] ?? 'samples/demo.srt';
const query = process.argv[3] ?? '人工智能';
const { cues, skipped } = parseSrt(readFileSync(file, 'utf8'));

console.log(`--- SRT 解析: ${file}`);
check('字幕条数', cues.length, 15);
check('跳过条数', skipped, 0);
check('首条时间(秒)', [cues[0].start, cues[0].end], [80, 85.5]);
check('首条文本', cues[0].text, '人工智能正在改变世界');

console.log(`\n--- 分词: ${query} ,AI / 芯片`);
check('关键词拆分', extractTerms('人工智能 ,AI / 芯片'), ['人工智能', 'AI', '芯片']);

console.log('\n--- 合并规则（合成字幕）');
const synth: SubtitleCue[] = [
  { seq: 1, start: 10, end: 14, text: '人工智能概述' },
  { seq: 2, start: 14.5, end: 18, text: '连续命中应合并' },
  { seq: 3, start: 26, end: 30, text: '间隔 8 秒 < 10 秒' },
  { seq: 4, start: 60, end: 64, text: '间隔 30 秒应另起一段' },
  { seq: 5, start: 64.2, end: 68, text: '尾部上下文' },
];
check('间隔 10 秒阈值下合并数量', buildClips(synth, '人工智能 连续 间隔').length, 2);
check('上下文扩展后片段起点', buildClips(synth, '人工智能')[0].start, 10);

console.log(`\n--- 主题检索: 「${query}」`);
const clips = buildClips(cues, query);
console.log(`候选片段 ${clips.length} 个`);
for (const clip of clips) {
  console.log(
    `  ${clip.start}s → ${clip.end}s  时长 ${(clip.end - clip.start).toFixed(1)}s  分数 ${clip.score}  命中 ${clip.matched.length} 条 / 共 ${clip.cues.length} 条字幕`,
  );
  console.log(`     证据: ${clip.matched.map((c: SubtitleCue) => `「${c.text.slice(0, 18)}」`).join(' ')}`);
}
check('demo.srt 命中「人工智能」的片段数', clips.length, 4);
check('第一个片段从 80 秒开始', clips[0].start, 80);
check(
  '片段起点全部是真实字幕起点',
  clips.every((c) => cues.some((q) => q.start === c.start)),
  true,
);
check(
  '片段终点要么是字幕终点、要么只是补到最短时长（不编造时间）',
  clips.every((c) => cues.some((q) => q.end === c.end) || c.end - c.start === 8),
  true,
);

const multi = buildClips(cues, '人工智能,芯片');
check('多关键词检索片段数', multi.length, 5);

console.log('\n--- FFmpeg 导出参数');
const { buildExportArgs, parseTime } = createRequire(import.meta.url)('../electron/services/ffmpeg.cjs');
check(
  '命令参数',
  buildExportArgs({ input: 'in.mp4', output: 'out.mp4', start: 80, end: 91.5 }),
  ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '80', '-to', '91.5', '-i', 'in.mp4', '-c', 'copy', '-progress', 'pipe:1', 'out.mp4'],
);
check('进度解析 out_time', parseTime('out_time=00:00:05.50'), 5.5);
check(
  '文件名建议',
  suggestFileName({ name: 'demo.mkv' } as never, { terms: ['人工智能'], start: 80, end: 91.5 } as never),
  'demo-人工智能-01m20-01m31.mp4',
);
check(
  '导出区间截断到视频末尾（AI 字幕尾部补白）',
  clampClipRange({ probe: { duration: 600.42 } } as never, { start: 357.6, end: 606.6 } as never),
  { start: 357.6, end: 600.42 },
);
check(
  '拿不到视频长度时不截断',
  clampClipRange({ probe: null } as never, { start: 10, end: 606.6 } as never),
  { start: 10, end: 606.6 },
);

console.log('\n--- AI 关键词解析');
const ai = createRequire(import.meta.url)('../electron/services/ai.cjs');

check('JSON 数组解析', ai.parseKeywords('["人工智能","AI","机器学习"]'), ['人工智能', 'AI', '机器学习']);
check('列表文本解析', ai.parseKeywords('- 人工智能\n- AI 落地\n3. 大模型'), ['人工智能', 'AI 落地', '大模型']);
check('去重', ai.parseKeywords('人工智能, 人工智能, AI').length, 2);
check('过滤单字', ai.parseKeywords('AI, 人工智能, 图').includes('图'), false);

console.log('\n--- AI 配置（endpoint 归一 / 密钥脱敏）');
check(
  '只填站点地址也能补成 chat/completions',
  ai.normalizeEndpoint('api.deepseek.com/v1/'),
  'https://api.deepseek.com/v1/chat/completions',
);
check(
  '已填完整 endpoint 时不重复拼接',
  ai.normalizeEndpoint('https://x.example.com/v1/chat/completions'),
  'https://x.example.com/v1/chat/completions',
);
check('空 endpoint 归一为空串', ai.normalizeEndpoint(''), '');
const legacyCfg = ai.resolveAiConfig({ llm: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'sk-abcdef123' } });
check('1.0 的 settings.llm 仍然生效', legacyCfg.ready, true);
check('按 endpoint 反推厂商', legacyCfg.provider, 'openai');
check('渲染层只拿脱敏密钥', [legacyCfg.hasKey, legacyCfg.keyTail], [true, 'f123']);
check('未填密钥时 ready=false', ai.resolveAiConfig({}).ready, false);
check(
  '第三方地址归为 custom',
  ai.resolveAiConfig({ ai: { endpoint: 'http://127.0.0.1:8787/v1' } }).provider,
  'custom',
);
check('中文按每字一 token 估算', ai.estimateTokens('人工智能正在改变世界'), 10);

console.log('\n--- AI 配置写入（合并 / 删除密钥 / 错误回显脱敏）');
check(
  '留空提交表示不修改，不会把已存密钥清掉',
  ai.mergeAiConfig({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-old-123' }, { model: 'deepseek-reasoner' }).apiKey,
  'sk-old-123',
);
check('只有显式 clearApiKey 才真的删除密钥', ai.mergeAiConfig({ apiKey: 'sk-old-123' }, { clearApiKey: true }).apiKey, '');
check(
  '派生值不落盘（配置文件里只有四个原始字段）',
  Object.keys(ai.mergeAiConfig({ apiKey: 'sk-old-123' }, { hasKey: false, keyTail: null, ready: false, model: 'm' })),
  ['provider', 'endpoint', 'model', 'apiKey'],
);
check('手填地址时 provider 归为 custom', ai.mergeAiConfig({}, { endpoint: 'http://127.0.0.1:8787/v1' }).provider, 'custom');
check('空配置回落到默认厂商', ai.mergeAiConfig({}, { apiKey: 'sk-x' }).provider, 'openai');
check(
  '合并后的配置仍能被归一读取',
  ai.resolveAiConfig({ ai: ai.mergeAiConfig({ apiKey: 'sk-abcdef123' }, { endpoint: 'api.deepseek.com/v1', model: 'deepseek-chat' }) }).ready,
  true,
);
check('错误信息里的密钥原文被替换', ai.redactSecret('接口说：sk-abcdef123 无效', { apiKey: 'sk-abcdef123' }), '接口说：*** 无效');
check('与密钥无关的文本原样保留', ai.redactSecret('触发限流或额度用尽（429）', { apiKey: 'sk-abcdef123' }), '触发限流或额度用尽（429）');

console.log('\n--- 字幕分块与 token 预算');
const manyCues: SubtitleCue[] = Array.from({ length: 6 }, (_, i) => ({
  seq: i + 1,
  start: i * 10,
  end: i * 10 + 9,
  text: '讨'.repeat(100),
}));
const chunks = ai.chunkCues(manyCues, 250);
check('按预算断开', chunks.length, 3);
check('分块只在字幕边界断开', chunks.reduce((n: number, c: { cues: SubtitleCue[] }) => n + c.cues.length, 0), 6);
check('块时间取真实字幕边界', [chunks[0].start, chunks[0].end], [0, 19]);
const plan = ai.planChunks(manyCues, { maxChunks: 2, budgetChars: 250 });
check('超上限时放大预算而不是丢内容', [plan.chunks.length, plan.coarsened, plan.requests], [2, true, 3]);
check('放大预算后字幕仍然齐全', plan.chunks.reduce((n: number, c: { cues: SubtitleCue[] }) => n + c.cues.length, 0), 6);

// 长字幕（2000 条 · 约 8 万字）：验收"任何字幕都不会因分块被静默丢弃"
const longCues: SubtitleCue[] = Array.from({ length: 2000 }, (_, i) => ({
  seq: i + 1,
  start: i * 3,
  end: i * 3 + 2.5,
  text: `第 ${i} 句字幕，讨论人工智能与内容行业的实际影响。`,
}));
const longPlan = ai.planChunks(longCues);
check('长字幕：块数收敛到上限内', longPlan.chunks.length <= ai.MAX_CHUNKS, true);
check(
  '极端长字幕（40 条 × 1000 字）也收敛到上限内且不丢',
  (() => {
    const huge: SubtitleCue[] = Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, start: i * 60, end: i * 60 + 59, text: '长'.repeat(1000) }));
    const p = ai.planChunks(huge, { maxChunks: 5 });
    return [p.chunks.length, p.chunks.reduce((n: number, c: { cues: unknown[] }) => n + c.cues.length, 0), p.coarsened];
  })(),
  [5, 40, true],
);
check('长字幕：超限被标记为"读粗"而不是丢弃', longPlan.coarsened, true);
check('长字幕：字幕条数一条不少', longPlan.chunks.reduce((n: number, c: { cues: SubtitleCue[] }) => n + c.cues.length, 0), 2000);
check(
  '长字幕：送分析的顺序与字幕原文完全一致',
  longPlan.chunks.flatMap((c: { cues: SubtitleCue[] }) => c.cues.map((x) => x.seq)),
  longCues.map((x) => x.seq),
);
check('长字幕：请求数 = 段数 + 一次汇总', longPlan.requests, longPlan.chunks.length + 1);
check(
  '长字幕：章节区间覆盖整片首尾',
  [longPlan.chunks[0].start, longPlan.chunks[longPlan.chunks.length - 1].end],
  [0, 1999 * 3 + 2.5],
);
check(
  '超长单条字幕独立成块，不会被丢掉',
  ai.chunkCues([{ seq: 1, start: 0, end: 1, text: '长'.repeat(5000) }, { seq: 2, start: 1, end: 2, text: '短' }], 300).map((c: { cues: SubtitleCue[] }) => c.cues.length),
  [1, 1],
);
check(
  'JSON 围栏与解释文字都能解析',
  [ai.parseJsonBlock('```json\n{"a":1}\n```').a, ai.parseJsonBlock('结果是 {"a":2} 供参考').a],
  [1, 2],
);
check('非 JSON 返回 null', ai.parseJsonBlock('纯文字'), null);
const scrubbed = ai.scrubTimestamps('在 01:23 处提到芯片产能，第 5 分钟补充说明');
check('模型编造的时间码被清除', [scrubbed.removed, scrubbed.text.includes('01:23'), scrubbed.text.includes('第 5 分钟')], [true, false, false]);
check('清洗后明确指回真实片段', scrubbed.text.includes('以左侧真实片段列表为准'), true);
check(
  '不含时间的回答原样保留',
  ai.scrubTimestamps('这段讲的是芯片供应链。'),
  { text: '这段讲的是芯片供应链。', removed: false },
);
const digestCues: SubtitleCue[] = [
  { seq: 1, start: 0, end: 2, text: '人工智能与芯片供应链' },
  { seq: 2, start: 2, end: 4, text: '人工智能的落地依赖芯片' },
  { seq: 3, start: 4, end: 6, text: '芯片产能决定人工智能节奏' },
];
const digest = ai.termDigest(digestCues, 10);
check('高频词来自字幕原文', ['人工智能', '芯片'].every((w) => digest.includes(w)), true);
check('长词里的切片噪声被丢掉', digest.includes('工智能'), false);

console.log('\n--- AI 调用错误处理（mock fetch）');
const AI_CFG = { endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', apiKey: 'sk-test' };
async function chatErr(fetchImpl: (url: string, init: { body: string; signal: AbortSignal }) => Promise<unknown>, opts: Record<string, unknown> = {}) {
  return ai
    .chat([{ role: 'user', content: '问题' }], AI_CFG, { fetchImpl, ...opts })
    .then(() => '')
    .catch((e: Error) => e.message);
}
let netCalls = 0;
const noKeyErr = await ai
  .chat([{ role: 'user', content: '问题' }], { ...AI_CFG, apiKey: '' }, {
    fetchImpl: async () => {
      netCalls += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    },
  })
  .then(() => '')
  .catch((e: Error) => e.message);
check('未配置密钥时给出可读提示', noKeyErr.includes('尚未配置'), true);
check('未配置密钥时不发起网络请求', netCalls, 0);
check(
  '401 归因到密钥无效',
  (await chatErr(async () => ({ ok: false, status: 401, text: async () => '{"error":"Invalid API key"}' }))).includes('API Key 无效'),
  true,
);
check(
  '404 提示检查 endpoint 地址',
  (await chatErr(async () => ({ ok: false, status: 404, text: async () => '' }))).includes('/chat/completions'),
  true,
);
check(
  '5xx 提示服务端错误',
  (await chatErr(async () => ({ ok: false, status: 503, text: async () => 'boom' }))).includes('AI 服务端错误（503）'),
  true,
);
check(
  '返回 HTML 时提示不是 JSON 接口',
  (await chatErr(async () => ({ ok: true, status: 200, text: async () => '<html>login</html>' }))).includes('不是 JSON'),
  true,
);
check(
  '模型空返回单独提示',
  (await chatErr(async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"   "}}]}' }))).includes('没有返回内容'),
  true,
);
check(
  '连不上接口时提示可行动',
  (await chatErr(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:1');
  })).includes('无法连接 AI 接口'),
  true,
);
check(
  '底层错误里回显了密钥也不会漏给用户',
  await chatErr(async () => {
    throw new Error(`bad auth for ${AI_CFG.apiKey}`);
  }),
  '无法连接 AI 接口：bad auth for ***',
);
check(
  '接口 400 响应体里回显密钥也会被截敏',
  await chatErr(async () => ({ ok: false, status: 400, text: async () => `your key ${AI_CFG.apiKey} is malformed` })),
  '请求不被接口接受（400）：模型名或参数可能不受支持。接口内容：your key *** is malformed',
);
check(
  '超时单独提示',
  (await chatErr(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    { timeoutMs: 20 },
  )).includes('AI 请求超时'),
  true,
);

check(
  '调用方取消能掐掉正在飞的请求（而不是报超时）',
  await (async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    return chatErr(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const abort = () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        }),
      { signal: ac.signal, timeoutMs: 5000 },
    );
  })(),
  '已取消。',
);

check(
  '请求结束后摘掉取消监听器（长字幕逐段复用同一 signal，不能堆泄漏）',
  await (async () => {
    const ac = new AbortController();
    const m = mockChat(['{"summary":"x"}', '{"summary":"y"}']);
    await ai.chat([{ role: 'user', content: 'hi' }], AI_CFG, { fetchImpl: m.fetchImpl, signal: ac.signal });
    await ai.chat([{ role: 'user', content: 'hi' }], AI_CFG, { fetchImpl: m.fetchImpl, signal: ac.signal });
    return getEventListeners(ac.signal, 'abort').length;
  })(),
  0,
);

console.log('\n--- mock AI 响应：全片分析 / 片段分析 / 问答');
function mockChat(contents: string[]) {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const queue = [...contents];
  const fetchImpl = async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const content = queue.shift() ?? '';
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  };
  return { bodies, fetchImpl };
}
const videoCues: SubtitleCue[] = [
  { seq: 1, start: 0, end: 100, text: '人'.repeat(100) },
  { seq: 2, start: 100, end: 200, text: '工'.repeat(100) },
];
const videoMock = mockChat([
  '{"title":"开篇","summary":"讲人工智能的应用","themes":["人工智能"],"keywords":["人工智能","应用"]}',
  '{"title":"芯片","summary":"讲芯片供应","themes":["芯片"],"keywords":["芯片","供应链"]}',
  '{"summary":"从人工智能应用讲到芯片供应","themes":["人工智能","芯片"],"keywords":["算力"]}',
]);
const insight = await ai.analyzeVideo(videoCues, AI_CFG, { fetchImpl: videoMock.fetchImpl, budgetChars: 200 });
check('逐段调用后再汇总一次', videoMock.bodies.length, 3);
check('章节时间取字幕真实边界', insight.chapters.map((c: AiChapter) => [c.start, c.end]), [[0, 100], [100, 200]]);
check('章节标题来自模型', insight.chapters.map((c: AiChapter) => c.title), ['开篇', '芯片']);
check('全片摘要来自汇总调用', insight.summary, '从人工智能应用讲到芯片供应');
check('主题与关键词归并', [insight.themes, insight.keywords], [['人工智能', '芯片'], ['算力']]);
check('上报分段数', [insight.chunks, insight.coarsened], [2, false]);
check('送给模型的是字幕正文', videoMock.bodies[0].messages[1].content.includes('人人'), true);
const singleMock = mockChat(['{"title":"整片","summary":"一条字幕也能分析","themes":["测试"],"keywords":["测试"]}']);
const singleInsight = await ai.analyzeVideo([{ seq: 1, start: 5, end: 9, text: '一条字幕' }] as SubtitleCue[], AI_CFG, {
  fetchImpl: singleMock.fetchImpl,
});
check('单段时不再多跑一次汇总', [singleMock.bodies.length, singleInsight.summary], [1, '一条字幕也能分析']);
const clipMock = mockChat(['{"summary":"开场钩子","points":["算力是基础"],"useCases":["开场"]}']);
check(
  '片段分析返回总结/观点/用途',
  await ai.analyzeClip([{ seq: 1, start: 0, end: 5, text: '人工智能正在改变世界' }] as SubtitleCue[], AI_CFG, {
    fetchImpl: clipMock.fetchImpl,
  }),
  { summary: '开场钩子', points: ['算力是基础'], useCases: ['开场'] },
);
check(
  '片段分析拿到乱码时报可读错误',
  await ai
    .analyzeClip([{ seq: 1, start: 0, end: 5, text: '一句话' }] as SubtitleCue[], AI_CFG, {
      fetchImpl: mockChat(['抱歉，我无法输出 JSON']).fetchImpl,
    })
    .then(() => '')
    .catch((e: Error) => e.message)
    .then((m: string) => m.includes('没有返回可解析的片段分析')),
  true,
);
const termsMock = mockChat(['["芯片","供应链","产能"]']);
const terms = await ai.extractQuestionTerms('芯片供应出了什么问题？', digestCues, AI_CFG, { fetchImpl: termsMock.fetchImpl });
check('问题 → 检索关键词', terms.keywords, ['芯片', '供应链', '产能']);
check('关键词生成带字幕高频词做地面真值', termsMock.bodies[0].messages[1].content.includes('人工智能'), true);
const answerMock = mockChat(['字幕里说产能决定节奏，见对应片段，大约在 02:10。']);
const answer = await ai.answerFromEvidence('芯片供应出了什么问题？', ['芯片产能决定人工智能节奏'], AI_CFG, {
  fetchImpl: answerMock.fetchImpl,
});
check('回答里的时间码被二次清洗', [answer.timestampsRemoved, answer.answer.includes('02:10')], [true, false]);
check('无引文时直接回答无法回答', (await ai.answerFromEvidence('问题', [], AI_CFG)).answer.includes('无法回答'), true);
check(
  '问答只把本地检索到的引文原样交给模型',
  answerMock.bodies[0].messages[1].content,
  '问题：芯片供应出了什么问题？\n\n字幕引文：\n芯片产能决定人工智能节奏',
);
const capMock = mockChat(['回答']);
await ai.answerFromEvidence(
  '问题',
  Array.from({ length: 60 }, (_x: unknown, i: number) => `第 ${i} 条字幕`),
  AI_CFG,
  { fetchImpl: capMock.fetchImpl },
);
check(
  '引文超过 40 条只送前 40 条',
  [capMock.bodies[0].messages[1].content.includes('第 39 条字幕'), capMock.bodies[0].messages[1].content.includes('第 40 条字幕')],
  [true, false],
);
const noEvMock = mockChat(['不该被调用']);
const noEv = await ai.answerFromEvidence('问题', [], AI_CFG, { fetchImpl: noEvMock.fetchImpl });
check('无引文时不再向模型请求（不花不必要的调用）', noEvMock.bodies.length, 0);
check('无引文时的回答如实说明无法回答', noEv.answer, '字幕里没有检索到与这个问题相关的内容，因此无法回答。');
check(
  '时间码清洗覆盖 时:分:秒 / 纯秒数 / 英文 s',
  [ai.scrubTimestamps('见 01:02:03').removed, ai.scrubTimestamps('见 45 秒').removed, ai.scrubTimestamps('see 90s').removed],
  [true, true, true],
);

console.log('\n--- 长字幕执行与失败恢复（mock）');
const OK_CHUNK = '{"title":"段落","summary":"一段摘要","themes":["主题"],"keywords":["关键词"]}';
const longContents = Array.from({ length: longPlan.requests }, (_x, i) =>
  i === longPlan.chunks.length ? '{"summary":"全片摘要","themes":["主题"],"keywords":["关键词"]}' : OK_CHUNK,
);
const longMock = mockChat(longContents);
const progress: Array<{ percent: number; stage: string }> = [];
const longInsight = await ai.analyzeVideo(longCues, AI_CFG, {
  fetchImpl: longMock.fetchImpl,
  onProgress: (p: { percent: number; stage: string }) => progress.push(p),
});
check('长字幕：请求数与计划一致', longMock.bodies.length, longPlan.requests);
check(
  '长字幕：每一条字幕都真的被送出去过（无静默丢弃）',
  longCues.every((c) => longMock.bodies.some((b) => b.messages.some((m) => String(m.content).includes(c.text)))),
  true,
);
check('长字幕：章节数 = 段数', longInsight.chapters.length, longPlan.chunks.length);
check(
  '长字幕：进度单调不回退',
  progress.every((p, i) => i === 0 || p.percent >= progress[i - 1].percent),
  true,
);
check('长字幕：进度最后到达 100', progress[progress.length - 1].percent, 100);
// 第 3 段失败：必须当场停下并把错误抛给用户，而不是继续把剩下的请求烧完
let longCalls = 0;
const failThird = mockChat(Array.from({ length: 30 }, () => OK_CHUNK));
const partialErr = await ai
  .analyzeVideo(longCues, AI_CFG, {
    fetchImpl: async (url: string, init: { body: string }) => {
      longCalls += 1;
      if (longCalls === 3) return { ok: false, status: 503, text: async () => 'upstream busy' };
      return failThird.fetchImpl(url, init);
    },
  })
  .then(() => '')
  .catch((e: Error) => e.message);
check('单段失败：报服务端错误', partialErr.includes('AI 服务端错误（503）'), true);
check('单段失败：立即停止，不继续烧后面的段', longCalls, 3);
check('单段失败：不返回半截"已完成"结论', partialErr.includes('完成'), false);
// 汇总段返回垃圾：退化为分段结论拼接，不编造全片摘要
const reduceGarbage = mockChat([...Array.from({ length: longPlan.chunks.length }, () => OK_CHUNK), '抱歉，我给出的是散文不是 JSON']);
const degraded = await ai.analyzeVideo(longCues, AI_CFG, { fetchImpl: reduceGarbage.fetchImpl });
check('汇总失败时退化为分段摘要拼接', degraded.summary.length > 0 && degraded.summary !== '抱歉，我给出的是散文不是 JSON', true);
check('退化时章节仍然完整', degraded.chapters.length, longPlan.chunks.length);
// 取消：段间检查点必须真的中断，且不再发出后续请求
let cancelCalls = 0;
const cancelMock = mockChat(longContents);
const cancelErr = await ai
  .analyzeVideo(longCues, AI_CFG, {
    isAborted: () => cancelCalls >= 2,
    fetchImpl: async (url: string, init: { body: string }) => {
      cancelCalls += 1;
      return cancelMock.fetchImpl(url, init);
    },
  })
  .then(() => '')
  .catch((e: Error) => e.message);
check('取消以「已取消」结束', cancelErr, '已取消。');
check('取消后不再发出后续请求', cancelCalls, 2);
// 重复分析：当前没有缓存，重复点击就是重复计费（如实记录在已知限制里）
const twiceMock = mockChat([...longContents, ...longContents]);
await ai.analyzeVideo(longCues, AI_CFG, { fetchImpl: twiceMock.fetchImpl });
await ai.analyzeVideo(longCues, AI_CFG, { fetchImpl: twiceMock.fetchImpl });
check('重复分析会产生重复请求（无缓存）', twiceMock.bodies.length, longPlan.requests * 2);

console.log('\n--- 字幕来源标记（生命周期）');
check('外挂字幕来源文案', subtitleSourceText('sidecar', 'movie.srt'), '外挂字幕 · movie.srt');
check('内嵌字幕来源文案', subtitleSourceText('embedded', 'movie.srt', 2), '内嵌字幕 · Embedded Subtitle Stream 0:2');
check('AI 生成来源文案', subtitleSourceText('ai', 'movie.generated.srt'), 'AI 生成 · movie.generated.srt');
check('手动导入来源文案', subtitleSourceText('manual', 'demo.srt'), '手动导入 · demo.srt');
check(
  '同目录字幕来源判定（AI 产物仍算 AI 生成）',
  [sidecarOrigin('movie.srt'), sidecarOrigin('movie.generated.srt'), sidecarOrigin('MOVIE.GENERATED.SRT')],
  ['sidecar', 'ai', 'ai'],
);
check(
  '解析结果默认来源为手动导入',
  toSubtitleSource({ path: 'x', name: 'demo.srt', bytes: 1, text: readFileSync('samples/demo.srt', 'utf8') }).origin,
  'manual',
);

console.log('\n--- 字幕自动探测 / Whisper 服务（离线可测部分）');
const subs = createRequire(import.meta.url)('../electron/services/subtitles.cjs');
const wsp = createRequire(import.meta.url)('../electron/services/whisper.cjs');
check(
  '同目录字幕匹配（精确名优先）',
  subs.matchSidecarNames(['movie.srt', 'movie.zh.srt', 'other.srt', 'movie.txt', 'movie.ass'], 'movie'),
  ['movie.srt', 'movie.zh.srt'],
);
check('大小写不同的视频名也能匹配', subs.matchSidecarNames(['Movie.SRT'], 'movie'), ['Movie.SRT']);
check(
  '内嵌字幕流解析',
  subs.parseSubtitleStreams(
    '  Stream #0:0(eng): Video: h264\n  Stream #0:1(chi): Audio: aac (LC)\n  Stream #0:2(spa): Subtitle: subrip (mov_text)',
  ),
  [{ index: 2, lang: 'spa', codec: 'subrip' }],
);
check('音轨存在性', [subs.hasAudioStream('Stream #0:1(eng): Audio: aac'), subs.hasAudioStream('Stream #0:0: Video')], [true, false]);
check(
  'mp4 带 [0x..] 标记的流也能识别',
  subs.hasAudioStream('Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono'),
  true,
);
check(
  '流类型全解析',
  subs.parseStreams(
    '  Stream #0:0[0x1](und): Video: h264 (Constrained Baseline)\n  Stream #0:1[0x2](und): Audio: aac (LC)\n  Stream #0:2[0x3](spa): Subtitle: subrip',
  ).map((s: { index: number; type: string; lang: string }) => `${s.index}:${s.type}:${s.lang}`),
  ['0:Video:und', '1:Audio:und', '2:Subtitle:spa'],
);
check(
  '提取参数用容器流序号',
  subs.buildExtractArgs({ input: 'm.mkv', streamIndex: 2, output: 'o.srt' }),
  ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'm.mkv', '-map', '0:2', '-c:s', 'srt', 'o.srt'],
);
check(
  'whisper 参数（auto 语言不传 -l）',
  wsp.buildTranscribeArgs({ model: 'ggml-base.bin', audio: 'a.wav', outBase: 'o', language: 'auto', threads: 4 }),
  ['-m', 'ggml-base.bin', '-f', 'a.wav', '-of', 'o', '-osrt', '-t', '4'],
);
check(
  'whisper 帮助页识别（真帮助 vs 命令不存在）',
  [
    wsp.looksLikeWhisperHelp('usage: whisper-cli [options]\n  -m, --model  path to the model'),
    wsp.looksLikeWhisperHelp("spawn whisper-cli ENOENT"),
    wsp.looksLikeWhisperHelp("'whisper-cli' 不是内部或外部命令"),
  ],
  [true, false, false],
);
check(
  'whisper 参数（指定语言）',
  wsp.buildTranscribeArgs({ model: 'm.bin', audio: 'a.wav', outBase: 'o', language: 'zh', threads: 0 }).includes('-l'),
  true,
);
check(
  'ffmpeg 抽音轨参数',
  wsp.buildAudioArgs({ input: 'v.mp4', output: 'a.wav' }),
  ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'v.mp4', '-vn', '-sn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', 'a.wav'],
);
const prog = wsp.parseProgress('progress =  120.50 / 780.00 secs ( 3.20 x)', 780);
check('progress 行 → 百分比', Math.round(prog.ratio * 100), 15);
check('progress 行 → 预计剩余(秒)', Math.round(prog.eta), 206);
check('无 progress 时用分段时间兜底', Math.round(wsp.parseProgress('[00:02:00.000 --> 00:02:03.000] 你好', 780).ratio * 100), 15);
check('完全无信号时不给出假进度', wsp.parseProgress('loading model', 780).ratio, null);
check(
  '设置归一：界面上选的档位/语言真的传给主进程',
  wsp.resolveConfig({ whisper: { modelSize: 'small', language: 'zh', threads: 8 }, modelPath: 'C:/m.bin' }),
  { modelSize: 'small', language: 'zh', threads: 8, modelPath: 'C:/m.bin', whisperPath: null },
);
check(
  '设置归一：非法/缺失回落到 base·auto·4 线程',
  wsp.resolveConfig({ whisper: { modelSize: 'huge' } }),
  { modelSize: 'base', language: 'auto', threads: 4, modelPath: null, whisperPath: null },
);
check(
  'whisper 产出的 SRT 能被现有解析器读取',
  parseSrt('1\n00:00:01,000 --> 00:00:05,000\n你好，欢迎观看这个视频\n\n2\n00:00:06,500 --> 00:00:09,000\n这是第二段\n').cues.length,
  2,
);

console.log(failures === 0 ? '\n全部断言通过' : `\n${failures} 条断言失败`);
process.exit(failures === 0 ? 0 : 1);
