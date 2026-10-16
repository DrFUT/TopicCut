/**
 * 1.5 AI Insight：本应用唯一的出网入口。
 * 全部调用留在主进程 —— API Key 不进渲染层，也不受渲染层 CORS 限制，
 * 并且任何厂商地址都由用户填写，代码里不写死密钥。
 */

const PROVIDERS = {
  openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom: { label: '自定义（OpenAI 兼容）', endpoint: '', model: '' },
};

const DEFAULT_AI_CONFIG = {
  provider: 'openai',
  endpoint: PROVIDERS.openai.endpoint,
  model: PROVIDERS.openai.model,
  apiKey: '',
};

const DEFAULT_TIMEOUT_MS = 60_000;
/** 中文字幕按"1 字 ≈ 1 token"保守估算 */
const CHUNK_BUDGET_CHARS = 3_200;
const MAX_CHUNKS = 12;
const MAX_OUTPUT_TOKENS = 900;
/** 送给"问题→关键词"步骤的字幕高频词上限：给模型的是词，不是带时间轴的字幕 */
const DIGEST_TERMS = 160;

const NO_KEY_MESSAGE =
  '尚未配置 AI 密钥。请在「设置 · AI Provider」里填写 API Key；不配置也能正常使用关键词搜索与本地字幕检索。';

/**
 * 纯函数：把用户填的地址归一成 OpenAI 兼容的 chat/completions 完整 URL。
 * 允许填 base（api.openai.com/v1）、带尾斜杠、或直接贴完整 endpoint。
 */
function normalizeEndpoint(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  s = s.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(s) ? s : s + '/chat/completions';
}

/**
 * 纯函数：读设置里的 AI 配置并归一。
 * 1.0 存的是 settings.llm，1.5 存 settings.ai —— 两处都要认，老用户配置不能失效。
 */
function resolveAiConfig(settings) {
  const s = settings || {};
  const a = s.ai || s.llm || {};
  const endpointRaw = String(a.endpoint || '').trim();
  const known = Object.keys(PROVIDERS).find(
    (k) => k !== 'custom' && PROVIDERS[k].endpoint && endpointRaw.startsWith(PROVIDERS[k].endpoint),
  );
  const provider = PROVIDERS[a.provider] ? a.provider : endpointRaw ? known || 'custom' : DEFAULT_AI_CONFIG.provider;
  const preset = PROVIDERS[provider] || PROVIDERS.custom;
  const endpoint = normalizeEndpoint(endpointRaw || preset.endpoint || '');
  const model = String(a.model || preset.model || '').trim();
  const apiKey = String(a.apiKey || '').trim();
  return {
    provider,
    endpoint,
    model,
    apiKey,
    /** 渲染层只拿到脱敏信息，永远拿不到密钥本身 */
    hasKey: !!apiKey,
    keyTail: apiKey ? apiKey.slice(-4) : null,
    ready: !!apiKey && !!endpoint && !!model,
  };
}

/**
 * 纯函数：把设置页提交的补丁合进已存配置，只保留四个原始字段。
 * 派生值（hasKey/keyTail/ready）一律不落盘 —— 否则文件里会同时存在真密钥和一个说谎的 hasKey:false。
 * apiKey 传空 = 保持原值；只有 clearApiKey 为真才删除，界面需要一个能真正撤销密钥的入口。
 */
function mergeAiConfig(stored, patch) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const p = patch && typeof patch === 'object' ? patch : {};
  const endpoint = strOf(p.endpoint) || strOf(s.endpoint) || '';
  const providerRaw = strOf(p.provider) || strOf(s.provider) || '';
  return {
    provider: PROVIDERS[providerRaw] ? providerRaw : endpoint ? 'custom' : DEFAULT_AI_CONFIG.provider,
    endpoint,
    model: strOf(p.model) || strOf(s.model) || '',
    apiKey: (p.clearApiKey ? '' : strOf(p.apiKey) || strOf(s.apiKey)) || '',
  };
}

/** 纯函数：任何要显示给用户的字符串先过一遍，确保密钥原文不会经错误信息回显 */
function redactSecret(text, cfg) {
  let s = String(text == null ? '' : text);
  const key = cfg && cfg.apiKey ? String(cfg.apiKey) : '';
  if (key.length >= 6) s = s.split(key).join('***');
  return s;
}

function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}

function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * 纯函数：按字符预算把字幕切成块，只在字幕条目边界断开。
 * 单条超长时独立成块，绝不丢字幕。
 */
function chunkCues(cues, budgetChars = CHUNK_BUDGET_CHARS) {
  const budget = Math.max(200, Number(budgetChars) || CHUNK_BUDGET_CHARS);
  const chunks = [];
  let current = [];
  let chars = 0;
  const push = () => {
    if (!current.length) return;
    chunks.push({
      index: chunks.length,
      start: current[0].start,
      end: current[current.length - 1].end,
      chars,
      cues: current,
    });
    current = [];
    chars = 0;
  };
  for (const cue of cues || []) {
    const len = String(cue.text || '').length + 1;
    if (current.length && chars + len > budget) push();
    current.push(cue);
    chars += len;
  }
  push();
  return chunks;
}

/**
 * 纯函数：块数超过上限时放大预算，而不是丢内容或丢精度。
 * 长片因此会被"读粗"，这一点在返回里如实标出来。
 */
function planChunks(cues, opts = {}) {
  const maxChunks = Number(opts.maxChunks) > 0 ? Number(opts.maxChunks) : MAX_CHUNKS;
  const budgetChars = Number(opts.budgetChars) > 0 ? Number(opts.budgetChars) : CHUNK_BUDGET_CHARS;
  let chunks = chunkCues(cues, budgetChars);
  const totalChars = chunks.reduce((n, c) => n + c.chars, 0);
  let coarsened = false;
  if (chunks.length > maxChunks) {
    coarsened = true;
    // 一次放大不一定够（每块都贴着预算时还会多出一两块），按比例递放大到真的进上限为止
    let budget = Math.ceil(totalChars / maxChunks) + 1;
    for (let i = 0; i < 20 && chunks.length > maxChunks; i += 1) {
      chunks = chunkCues(cues, budget);
      if (chunks.length > maxChunks) budget = Math.ceil((budget * chunks.length) / maxChunks) + 1;
    }
  }
  return { chunks, coarsened, totalChars, requests: chunks.length + (chunks.length > 1 ? 1 : 0) };
}

/** 纯函数：容忍 ```json 围栏与前后解释文字 */
function parseJsonBlock(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = (fence ? fence[1] : s).trim();
  try {
    return JSON.parse(body);
  } catch {
    /* 继续尝试截取 */
  }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const i = body.indexOf(open);
    const j = body.lastIndexOf(close);
    if (i !== -1 && j > i) {
      try {
        return JSON.parse(body.slice(i, j + 1));
      } catch {
        /* 换下一种 */
      }
    }
  }
  return null;
}

function strOf(v) {
  return String(v == null ? '' : v).trim();
}

function arrayOf(v, max = 8) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(strOf).filter((x) => x.length >= 1 && x.length <= 60))].slice(0, max);
}

/** 从模型返回文本里提取关键词数组（容忍非 JSON 输出） */
function parseKeywords(raw) {
  const text = String(raw || '');
  let words = [];
  const jsonMatch = /\[[\s\S]*?\]/.exec(text);
  if (jsonMatch) {
    const parsed = parseJsonBlock(jsonMatch[0]);
    if (Array.isArray(parsed)) words = parsed.map((x) => String(x));
    else words = jsonMatch[0].slice(1, -1).split(',');
  }
  if (words.length === 0) {
    words = text.split(/[\n,，、;；]+/);
  }
  return [
    ...new Set(
      words
        .map((w) => w.replace(/^[\s\-•*\d.、]+/, '').replace(/^["'`「『]|["'」』]$/g, '').trim())
        .filter((w) => w.length >= 2 && w.length <= 24),
    ),
  ].slice(0, 8);
}

/**
 * 纯函数：把模型偶尔写出的时间码抹掉。
 * 时间只能来自 TopicCut 的真实字幕检索，这是 1.5 的硬约束。
 */
function scrubTimestamps(text) {
  const s = String(text || '');
  const cleaned = s
    .replace(/\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?/g, '')
    .replace(/第\s*\d+\s*(秒|分钟|小时)/g, '')
    .replace(/\d+(\.\d+)?\s*(秒|分钟)/g, '')
    .replace(/\d+(\.\d+)?\s*s\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；、！？])/g, '$1');
  const removed = cleaned !== s;
  return {
    text: removed ? cleaned.trim() + '（回答中的时间以左侧真实片段列表为准）' : s.trim(),
    removed,
  };
}

/** 纯函数：字幕高频词摘要，给"问题→关键词"当地面真值，避免模型凭空造词 */
function termDigest(cues, maxTerms = DIGEST_TERMS) {
  const counts = new Map();
  const bump = (w) => counts.set(w, (counts.get(w) || 0) + 1);
  for (const cue of cues || []) {
    const text = String(cue.text || '');
    for (const m of text.matchAll(/[一-鿿㐀-䶿]{2,}/g)) {
      const run = m[0];
      for (let n = 2; n <= 4 && n <= run.length; n += 1) {
        for (let i = 0; i + n <= run.length; i += 1) bump(run.slice(i, i + n));
      }
    }
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+.#-]{1,}/g)) bump(m[0].toLowerCase());
  }
  const ranked = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([w, c]) => ({ w, c, score: c * (w.length - 1) }))
    .sort((a, b) => b.score - a.score || a.w.localeCompare(b.w));
  // 只出现在更长词里的短词是冗余信息（"工智能正"这类切片），丢掉才能给模型一份干净的选词表
  const pool = ranked.slice(0, Math.max(maxTerms * 4, maxTerms));
  const kept = [];
  for (const item of pool) {
    const redundant = kept.some((k) => k.w.length > item.w.length && k.w.includes(item.w) && k.c >= item.c);
    if (!redundant) kept.push(item);
    if (kept.length >= maxTerms) break;
  }
  return kept.map((x) => x.w);
}

function errText(err) {
  if (!err) return '未知错误';
  if (err.name === 'AbortError') return '请求被中止';
  const code = err.cause && err.cause.code ? err.cause.code : err.code;
  return String(err.message || err.name || code || err);
}

function statusHint(status, body) {
  const tail = String(body || '').replace(/\s+/g, ' ').slice(0, 160);
  const map = {
    400: '请求不被接口接受（400）：模型名或参数可能不受支持',
    401: 'API Key 无效，或这把 Key 不属于这个接口（401）',
    403: '接口拒绝访问（403）：检查 Key 权限与模型名',
    404: '接口地址或模型不存在（404）：endpoint 需要指到 OpenAI 兼容的 /chat/completions',
    408: '接口侧超时（408）：稍后重试或换更小的模型',
    429: '触发限流或额度用尽（429）：稍后再试',
  };
  const base = map[status] || (status >= 500 ? `AI 服务端错误（${status}）：稍后重试` : `AI 接口返回 ${status}`);
  return tail ? `${base}。接口内容：${tail}` : `${base}。`;
}

/** 一次 Chat Completions 调用：带超时、错误归因、脱敏后返回文本 */
async function chat(messages, cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error('当前运行环境没有 fetch，无法调用 AI 接口。');
  if (!cfg || !cfg.apiKey) throw new Error(NO_KEY_MESSAGE);
  if (!cfg.endpoint) throw new Error('未配置 AI 接口地址（endpoint）。');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  // 用户点「取消」时要能掐掉正在飞的那个请求，而不是等这一段跑完
  let onAbort;
  if (opts.signal && typeof opts.signal.addEventListener === 'function') {
    if (opts.signal.aborted) controller.abort();
    else {
      onAbort = () => controller.abort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
          max_tokens: Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : MAX_OUTPUT_TOKENS,
          messages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      const canceled = !!(opts.signal && opts.signal.aborted);
      const aborted = (err && err.name === 'AbortError') || controller.signal.aborted;
      throw new Error(
        redactSecret(
          canceled
            ? '已取消。'
            : aborted
            ? `AI 请求超时（${Math.max(1, Math.round(timeoutMs / 1000))} 秒）：检查网络与接口地址，或换更小的模型再试。`
            : `无法连接 AI 接口：${errText(err)}`,
          cfg,
        ),
      );
    }

    const body = await (typeof res.text === 'function' ? res.text() : Promise.resolve(''));
    if (!res.ok) throw new Error(redactSecret(statusHint(res.status, body), cfg));

    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error('AI 接口返回的不是 JSON：请确认 endpoint 指向 OpenAI 兼容的 /chat/completions。');
    }
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    if (!strOf(text)) throw new Error('AI 没有返回内容：模型名可能不对，或该请求被模型拒绝。');
    return { text: String(text), usage: data.usage || null };
  } finally {
    clearTimeout(timer);
    // 复用同一个 signal 逐段请求：不摘掉就会在长字幕场景里堆出几十个监听器（Node 会报泄漏警告）
    if (onAbort && typeof opts.signal.removeEventListener === 'function') {
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

function cueText(cues) {
  return (cues || []).map((c) => strOf(c.text)).filter(Boolean).join('\n');
}

const JSON_ONLY = '只输出 JSON，不要 Markdown 围栏，不要任何解释文字。';

/**
 * 全片分析：分块 → 逐块要章节名/摘要/主题/关键词 → 汇总出全片结论。
 * 章节的起止时间一律取字幕真实边界，模型只负责文字。
 */
async function analyzeVideo(cues, cfg, opts = {}) {
  const t0 = Date.now();
  const list = (cues || []).filter((c) => strOf(c.text));
  if (!list.length) throw new Error('还没有字幕，无法做 AI 分析。');
  const report = (percent, stage) => opts.onProgress && opts.onProgress({ percent, stage });

  const plan = planChunks(list, opts);
  const parts = [];
  for (let i = 0; i < plan.chunks.length; i += 1) {
    if (opts.isAborted && opts.isAborted()) throw new Error('已取消。');
    const chunk = plan.chunks[i];
    report(Math.round((i / plan.requests) * 90), `分析第 ${i + 1}/${plan.chunks.length} 段`);
    const { text } = await chat(
      [
        { role: 'system', content: `你是视频字幕分析器，中文输出。${JSON_ONLY}` },
        {
          role: 'user',
          content:
            `这是视频字幕的第 ${i + 1}/${plan.chunks.length} 段（约 ${clock(chunk.start)}–${clock(chunk.end)}）。\n` +
            `输出字段：{"title":"这段的章节名（不超过 12 字）","summary":"这段在讲什么（不超过 80 字）",` +
            `"themes":["这段的主题词，2-4 个"],"keywords":["观众可能用来搜索这段的词，3-6 个，尽量是字幕里出现过的原词"]}\n\n` +
            cueText(chunk.cues),
        },
      ],
      cfg,
      opts,
    );
    const obj = parseJsonBlock(text) || {};
    parts.push({
      start: Number(chunk.start.toFixed(2)),
      end: Number(chunk.end.toFixed(2)),
      title: strOf(obj.title) || `段落 ${i + 1}`,
      summary: strOf(obj.summary),
      themes: arrayOf(obj.themes, 6),
      keywords: arrayOf(obj.keywords, 8),
    });
  }

  let summary = '';
  let themes = [];
  let keywords = [];
  if (parts.length > 1) {
    report(92, '汇总全片结论');
    const digest = parts
      .map((p, i) => `${i + 1}. ${p.title}（${clock(p.start)}-${clock(p.end)}）：${p.summary}`)
      .join('\n');
    const { text } = await chat(
      [
        { role: 'system', content: `你是视频内容编辑，中文输出。${JSON_ONLY}` },
        {
          role: 'user',
          content:
            '下面是同一个视频分段分析的结果。输出 ' +
            '{"summary":"全片摘要，不超过 200 字","themes":["主要主题，3-6 个"],"keywords":["关键词，5-10 个"]}。' +
            '不要编造分段结论里没有的信息。\n\n' +
            digest,
        },
      ],
      cfg,
      opts,
    );
    const obj = parseJsonBlock(text) || {};
    summary = strOf(obj.summary);
    themes = arrayOf(obj.themes, 8);
    keywords = arrayOf(obj.keywords, 12);
  } else {
    summary = parts[0].summary;
    themes = parts[0].themes;
    keywords = parts[0].keywords;
  }

  report(100, '完成');
  return {
    summary:
      summary ||
      parts
        .map((p) => p.summary)
        .filter(Boolean)
        .join(' '),
    themes: themes.length ? themes : arrayOf(parts.flatMap((p) => p.themes), 8),
    keywords: keywords.length ? keywords : arrayOf(parts.flatMap((p) => p.keywords), 12),
    chapters: parts.map((p) => ({ start: p.start, end: p.end, title: p.title, summary: p.summary })),
    chunks: parts.length,
    coarsened: plan.coarsened,
    elapsedMs: Date.now() - t0,
  };
}

/** 片段级分析：输入就是这个片段已经检索到的字幕，输出文字结论 */
async function analyzeClip(cues, cfg, opts = {}) {
  const list = (cues || []).filter((c) => strOf(c.text));
  if (!list.length) throw new Error('这个片段没有可用于分析的字幕文本。');
  const { text } = await chat(
    [
      { role: 'system', content: `你是短视频编辑，中文输出。${JSON_ONLY}` },
      {
        role: 'user',
        content:
          '这是一个候选片段的全部字幕。输出 ' +
          '{"summary":"内容总结（不超过 60 字）","points":["核心观点，1-4 条"],"useCases":["推荐用途，1-3 条，例如开场钩子/案例佐证/结尾升华"]}。' +
          '只依据字幕内容，不要引入字幕里没有的事实。\n\n' +
          cueText(list),
      },
    ],
    cfg,
    opts,
  );
  const obj = parseJsonBlock(text) || {};
  const summary = strOf(obj.summary);
  if (!summary && !arrayOf(obj.points).length) throw new Error('AI 没有返回可解析的片段分析结果，请重试或换个片段。');
  return { summary, points: arrayOf(obj.points, 6), useCases: arrayOf(obj.useCases, 4) };
}

/**
 * 问答第一步：问题 → 检索关键词。
 * 这里刻意不问模型"答案在第几分钟"——时间轴由本地字幕检索给出，模型只出词。
 */
async function extractQuestionTerms(question, cues, cfg, opts = {}) {
  const q = strOf(question);
  if (!q) throw new Error('先输入一个问题。');
  const digest = termDigest(cues, opts.digestTerms || DIGEST_TERMS);
  const { text } = await chat(
    [
      {
        role: 'system',
        content:
          '你是视频字幕检索的关键词生成器。用户给一个问题，你输出 3-8 个最可能原样出现在这份字幕里的检索词，' +
          '优先使用字幕高频词里的写法，包含同义词、简称、英文缩写与常见变体。' +
          '绝对不要输出时间、秒数或时间码。只输出 JSON 字符串数组。',
      },
      {
        role: 'user',
        content: `问题：${q}\n\n这份字幕里的高频词（供你选词参考）：${digest.join('、') || '（无）'}`,
      },
    ],
    cfg,
    opts,
  );
  const keywords = parseKeywords(text);
  if (!keywords.length) throw new Error('AI 没能给出可用关键词，请换个说法，或直接在搜索框输入关键词。');
  return { keywords, digestSize: digest.length };
}

/** 问答第二步：拿本地检索到的真实引文写答案，并对时间码做二次清洗 */
async function answerFromEvidence(question, evidence, cfg, opts = {}) {
  const lines = (evidence || []).map(strOf).filter(Boolean);
  if (!lines.length) return { answer: '字幕里没有检索到与这个问题相关的内容，因此无法回答。', keywords: [] };
  const { text } = await chat(
    [
      {
        role: 'system',
        content:
          '你是视频内容问答助手。只依据用户给出的字幕引文回答，引文里没有的不要补充。' +
          '禁止输出任何时间码、秒数或"第几分钟"，需要指路时说"见对应片段"。中文，不超过 200 字。',
      },
      { role: 'user', content: `问题：${strOf(question)}\n\n字幕引文：\n${lines.slice(0, 40).join('\n')}` },
    ],
    cfg,
    opts,
  );
  const scrubbed = scrubTimestamps(text);
  return { answer: scrubbed.text, timestampsRemoved: scrubbed.removed };
}

/** 设置页的「测试连接」：一次最小请求，验证 endpoint + key + model 三者是否自洽 */
async function testConnection(cfg, opts = {}) {
  const t0 = Date.now();
  const { text } = await chat([{ role: 'user', content: '回复两个字：已连接' }], cfg, {
    ...opts,
    temperature: 0,
    maxTokens: 16,
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15_000,
  });
  return { ok: true, model: cfg.model, latencyMs: Date.now() - t0, sample: strOf(text).slice(0, 40) };
}

module.exports = {
  PROVIDERS,
  DEFAULT_AI_CONFIG,
  DEFAULT_TIMEOUT_MS,
  CHUNK_BUDGET_CHARS,
  MAX_CHUNKS,
  MAX_OUTPUT_TOKENS,
  NO_KEY_MESSAGE,
  normalizeEndpoint,
  resolveAiConfig,
  mergeAiConfig,
  redactSecret,
  estimateTokens,
  clock,
  chunkCues,
  planChunks,
  parseJsonBlock,
  parseKeywords,
  scrubTimestamps,
  termDigest,
  chat,
  analyzeVideo,
  analyzeClip,
  extractQuestionTerms,
  answerFromEvidence,
  testConnection,
};
