// 1.5 AI Insight 端到端验证：起一个本地 mock 的 OpenAI 兼容接口，驱动真实 Electron 界面跑完整流程。
// 只监听 127.0.0.1，不发任何真实网络请求、不上传视频；mock 按提示词类型返回固定 JSON。
// 用法：npm run verify:ai
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const work = path.join(root, '.selfcheck');
const apiKey = 'sk-topiccut-mock-key-9f2c';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} → ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
};
const info = (label, value) => console.log(`     ${label} ${JSON.stringify(value)}`);

const REPLIES = {
  chunk: {
    title: '人工智能与内容行业',
    summary: '这段字幕讨论人工智能如何改变内容行业的工作方式，并强调人的判断仍然不可省略。',
    themes: ['人工智能', '内容行业'],
    keywords: ['人工智能', '剪辑', '工作流'],
  },
  reduce: { summary: '全片从人工智能的能力讲到对剪辑岗位的实际影响。', themes: ['人工智能', '岗位变化'], keywords: ['人工智能', '剪辑', '工作流'] },
  clip: { summary: '这段适合作为开场钩子', points: ['机器可以给出剪辑建议', '建议需要人来确认'], useCases: ['开场钩子', '选题引入'] },
  terms: ['人工智能', '内容'],
  // 用于「无相关证据」的问题：这些词在样片字幕里根本不存在，检索必须 0 命中
  deadTerms: ['火箭发动机', '低温燃料'],
  // 故意夹带一个编造的时间码，用来验证「时间只能来自真实字幕检索」这条硬约束
  answer: '字幕里的结论是机器能给出剪辑建议，但仍需人来确认，见对应片段（约 02:10）。',
  ping: '已连接',
};

/** 只按提示词的角色判断该回什么，不理解内容——这样每个 UI 动作都能在 mock 侧对上号 */
function classify(body) {
  const sys = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('');
  if (sys.includes('关键词生成器')) return 'terms';
  if (sys.includes('问答助手')) return 'answer';
  if (sys.includes('短视频编辑')) return 'clip';
  if (sys.includes('视频内容编辑')) return 'reduce';
  if (sys.includes('字幕分析器')) return 'chunk';
  return 'ping';
}

const completions = (content) =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 120 } });

const stats = { requests: 0, authed: 0, byMode: {}, answered: {}, flakyChunk: 0, promptChars: 0, sawCueText: false, sawMediaRef: false, fieldSets: [], models: [], log: [] };

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/__stats')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const mode = /mode=(\w+)/.exec(req.url || '')?.[1] || 'ok';
    stats.requests += 1;
    stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;
    if (req.headers.authorization === `Bearer ${apiKey}`) stats.authed += 1;    const body = JSON.parse(raw || '{}');
    const chars = (body.messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
    const kind = classify(body);
    stats.promptChars += chars;
    stats.models.push(body.model);
    if ((body.messages || []).map((m) => String(m.content || '')).join('\n').includes('人工智能不会取代剪辑师')) stats.sawCueText = true;
    // 隐私审计：任何媒体文件名 / 本地路径都不该出现在请求体里；请求体字段必须只有约定的四个
    if (/\.(mp4|mkv|mov|wav|srt|ass|vtt)\b|[a-z]:[\\/]/i.test(raw)) stats.sawMediaRef = true;
    const fields = Object.keys(body).sort().join(',');
    if (!stats.fieldSets.includes(fields)) stats.fieldSets.push(fields);
    stats.log.push({ mode, kind, chars, hasAuth: !!req.headers.authorization, realKey: req.headers.authorization === `Bearer ${apiKey}` });

    if (mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      return;
    }
    if (mode === 'err') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('upstream boom');
      return;
    }
    if (mode === 'flaky' && kind === 'chunk') {
      // 前两块成功、第三块失败：验"单块失败时立刻停止，不烧完剩余段"
      stats.flakyChunk = (stats.flakyChunk || 0) + 1;
      if (stats.flakyChunk >= 3) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('flaky upstream boom');
        return;
      }
    }
    if (mode === 'dead' && kind === 'terms') {
      // 关键词与字幕完全无关：验证后续不会拿无关字幕凑证据、也不会再多发一次问答请求
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(completions(JSON.stringify(REPLIES.deadTerms)));
      return;
    }
    if (mode === 'slow') {
      // 故意不回话：客户端取消后不应该再收到任何响应
      const timer = setTimeout(() => {
        stats.answered.slow = (stats.answered.slow || 0) + 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(completions(JSON.stringify(REPLIES.chunk)));
      }, 30000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    stats.answered[kind] = (stats.answered[kind] || 0) + 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(completions(kind === 'answer' || kind === 'ping' ? REPLIES[kind] : JSON.stringify(REPLIES[kind])));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/v1`;
console.log(`--- 0. 本地 mock AI 接口 ${base}/chat/completions（仅监听 127.0.0.1）`);

fs.mkdirSync(work, { recursive: true });
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('FAIL 还没有构建产物，请先 npm run build（或直接 npm run verify:ai）。');
  process.exit(1);
}

// 长字幕素材：2000 条字幕挂在一段真实生成的小视频旁边，用来在真实界面上验分块与"不丢字幕"
const ffmpegSvc = require('../electron/services/ffmpeg.cjs');
const LONG_CUES = 2000;
const longVideo = path.join(work, 'topiccut-long.mp4');
const longSrt = path.join(work, 'topiccut-long.srt');
let longTotalChars = 0;
{
  const det = await ffmpegSvc.detect(process.env.FFMPEG_PATH);
  if (!det.found) {
    console.error('FAIL 长字幕场景需要本机 FFmpeg 生成素材：' + (det.error || '未检测到可用 ffmpeg'));
    process.exit(1);
  }
  const lines = [];
  for (let i = 0; i < LONG_CUES; i += 1) {
    const text = `第 ${i} 句字幕，讨论人工智能与内容行业的实际影响。`;
    longTotalChars += text.length;
    const at = (sec) => {
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const s = String(Math.floor(sec % 60)).padStart(2, '0');
      return `${h}:${m}:${s},${String(Math.round((sec % 1) * 1000)).padStart(3, '0')}`;
    };
    lines.push(`${i + 1}\n${at(i * 3)} --> ${at(i * 3 + 2.5)}\n${text}\n`);
  }
  fs.writeFileSync(longSrt, lines.join('\n'), 'utf8');
  if (!fs.existsSync(longVideo)) {
    const r = spawnSync(det.path, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', longVideo], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('FAIL 无法生成长字幕场景视频：' + String(r.stderr || '').slice(-400));
      process.exit(1);
    }
  }
  console.log(`--- 0b. 长字幕素材 ${LONG_CUES} 条 / ${longTotalChars} 字符 + ${path.basename(longVideo)}`);
}

console.log('\n--- 1. 启动 Electron，按界面真实动作跑 AI 场景');
const electronBin = require('electron');
const child = spawn(electronBin, ['.'], {
  cwd: root,
  env: {
    ...process.env,
    TOPICCUT_DEMO: '1',
    TOPICCUT_SCENARIO: 'ai',
    TOPICCUT_AI_BASE: base,
    TOPICCUT_AI_STATS: `http://127.0.0.1:${port}/__stats`,
    TOPICCUT_AI_KEY: apiKey,
    TOPICCUT_LONG_VIDEO: longVideo,
    TOPICCUT_LONG_CUES: String(LONG_CUES),
    TOPICCUT_LONG_CHARS: String(longTotalChars),
  },
});
let out = '';
child.stdout.on('data', (d) => {
  const text = d.toString();
  out += text;
  for (const line of text.split('\n')) if (/AI_(PASS|FAIL|INFO|SUMMARY)/.test(line)) console.log(line.trim());
});
child.stderr.on('data', (d) => {
  const text = d.toString();
  if (!/DevTools|GPU|swift_shader|Fontconfig|dbus|EGL|libva|sandbox/i.test(text)) process.stderr.write(text);
});
const watchdog = setTimeout(() => {
  console.error('FAIL 场景超过 5 分钟未结束，强制终止');
  child.kill('SIGKILL');
}, 300_000);
const code = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(watchdog);
server.closeAllConnections();
server.close();

const reportPath = path.join(work, 'ai.json');
if (!fs.existsSync(reportPath)) {
  console.error(`FAIL 场景没有跑完（electron exit=${code}，缺少 .selfcheck/ai.json）`);
  console.error(out.slice(-2000));
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log('\n--- 2. 链路事实（mock 服务端记录）');
info('请求总数', stats.requests);
info('按模式分布', stats.byMode);
info('请求序列', stats.log.map((l) => `${l.mode}:${l.kind}`).join(' → '));
info('累计送出字符', stats.promptChars);
check('每次请求都带 Authorization 头', stats.log.every((l) => l.hasAuth), true);
check(
  '用真密钥的那几次带的都是本机保存的值',
  stats.authed,
  stats.log.filter((l) => ['ok', 'slow', 'flaky', 'dead'].includes(l.mode)).length,
);
check(
  'D/I 组故意用的错误密钥没有一次被当成正确密钥通过',
  stats.log.filter((l) => l.mode === 'auth').every((l) => l.realKey === false),
  true,
);
check('模型名取自用户填写的配置', [...new Set(stats.models)], ['mock-mini']);
check('字幕原文被送去分析', stats.sawCueText, true);
check('请求体只有约定的四个字段', stats.fieldSets, ['max_tokens,messages,model,temperature']);
check('没有任何媒体文件名或本地路径被送出', stats.sawMediaRef, false);
check('取消后 slow 请求没有一条被回复', stats.answered.slow || 0, 0);

const settingsFile = path.join(work, 'userdata-ai', 'topiccut-settings.json');
check('密钥只写进本机 userData 配置文件', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ai.apiKey, apiKey);
const realSettings = path.join(process.env.APPDATA || '', 'topiccut', 'topiccut-settings.json');
check(
  '测试没有污染真实用户配置',
  fs.existsSync(realSettings) && fs.readFileSync(realSettings, 'utf8').includes(apiKey),
  false,
);

console.log(`\n界面场景：${report.passed} 通过 / ${report.failed} 失败`);
console.log(`截图：${path.join(work, 'ai.png')}`);
failures += report.failed;
console.log(failures === 0 ? '\nAI Insight 端到端验证通过' : `\n${failures} 条断言失败`);
process.exit(failures === 0 && code === 0 ? 0 : 1);
