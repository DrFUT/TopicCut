const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ffmpeg = require('./services/ffmpeg.cjs');
const subtitles = require('./services/subtitles.cjs');
const whisper = require('./services/whisper.cjs');
const ai = require('./services/ai.cjs');
const { SettingsStore } = require('./services/settings.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;
// TOPICCUT_SCENARIO=1 跑字幕来源场景；=ai 跑 1.5 AI Insight 场景（对本地 mock 接口）
const SCENARIO_MODE = process.env.TOPICCUT_SCENARIO || '';
const SCENARIO = SCENARIO_MODE === '1' || SCENARIO_MODE === 'ai';

// AI 场景用独立的 userData 目录：测试写入的 mock endpoint 与假密钥不会污染真实用户配置
if (SCENARIO_MODE === 'ai') {
  const isolated = path.join(__dirname, '..', '.selfcheck', 'userdata-ai');
  fs.mkdirSync(isolated, { recursive: true });
  fs.rmSync(path.join(isolated, 'topiccut-settings.json'), { force: true });
  app.setPath('userData', isolated);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'topiccut-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

let win = null;
let settings = null;
let ffmpegState = { found: false, path: null, version: null, checked: false };
let whisperState = { found: false, path: null, version: null, model: { found: false, path: null, name: null, bytes: 0 }, checked: false };

async function recheckFfmpeg() {
  ffmpegState = { ...(await ffmpeg.detect(settings.read().ffmpegPath)), checked: true };
  return ffmpegState;
}

async function recheckWhisper() {
  const cfg = whisper.resolveConfig(settings.read());
  const cli = await whisper.detect(cfg.whisperPath);
  const model = whisper.detectModel({ modelPath: cfg.modelPath, whisperPath: cli.path, size: cfg.modelSize });
  whisperState = { ...cli, model, checked: true };
  return whisperState;
}

function readSubtitleFile(filePath) {
  return {
    path: filePath,
    name: path.basename(filePath),
    bytes: fs.statSync(filePath).size,
    text: decodeSubtitle(fs.readFileSync(filePath)),
  };
}

function decodeSubtitle(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('latin1');
    }
  }
}

function toMediaUrl(filePath) {
  return 'topiccut-media:///' + encodeURIComponent(String(filePath).replace(/\\/g, '/'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#07080b',
    show: false,
    title: 'TopicCut',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  if (isDev) {
    win.loadURL(SCENARIO ? DEV_URL + (DEV_URL.includes('?') ? '&' : '?') + 'selfcheck=1' : DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), SCENARIO ? { query: { selfcheck: '1' } } : undefined);
  }
}

async function buildVideoSource(filePath) {
  const stat = fs.statSync(filePath);
  await recheckFfmpeg();
  const probe = ffmpegState.found ? await ffmpeg.probe(filePath, ffmpegState.path) : null;
  return {
    path: filePath,
    name: path.basename(filePath),
    dir: path.dirname(filePath),
    bytes: stat.size,
    mtime: stat.mtimeMs,
    probe,
    mediaUrl: toMediaUrl(filePath),
  };
}

ipcMain.handle('dialog:pickVideo', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择视频文件',
    properties: ['openFile'],
    filters: [{ name: '视频 (mp4 / mkv / mov)', extensions: ['mp4', 'mkv', 'mov'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return buildVideoSource(r.filePaths[0]);
});

// 自检专用：绕过文件对话框按路径构造视频信息，普通运行下直接拒绝
ipcMain.handle('video:source', async (_e, filePath) => {
  if (!SCENARIO) return null;
  if (!filePath || !fs.existsSync(filePath)) return null;
  return buildVideoSource(filePath);
});

ipcMain.handle('dialog:pickSubtitle', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 SRT 字幕文件',
    properties: ['openFile'],
    filters: [{ name: 'SubRip 字幕 (*.srt)', extensions: ['srt', 'txt'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  return {
    path: filePath,
    name: path.basename(filePath),
    text: decodeSubtitle(fs.readFileSync(filePath)),
    bytes: fs.statSync(filePath).size,
  };
});

ipcMain.handle('ffmpeg:detect', async () => recheckFfmpeg());

ipcMain.handle('ffmpeg:probe', async (_e, filePath) => {
  if (!ffmpegState.found) return null;
  return ffmpeg.probe(filePath, ffmpegState.path);
});

ipcMain.handle('settings:get', () => settings.read());
ipcMain.handle('settings:set', (_e, patch) => settings.write(patch));

ipcMain.handle('clip:export', async (_e, payload) => {
  const { input, start, end, suggestedName } = payload;
  if (!ffmpegState.found) {
    return { ok: false, error: '未检测到 FFmpeg。请在设置中填写 ffmpeg 可执行文件路径，或安装 FFmpeg 后重试。' };
  }
  const out = await dialog.showSaveDialog(win, {
    title: '导出片段',
    defaultPath: path.join(path.dirname(input), suggestedName),
    filters: [{ name: '视频', extensions: ['mp4'] }],
  });
  if (out.canceled || !out.filePath) return { ok: false, canceled: true };

  win.webContents.send('export:progress', { start, end, percent: 0 });
  try {
    const res = await ffmpeg.exportClip({
      ffmpegPath: ffmpegState.path,
      input,
      output: out.filePath,
      start,
      end,
      onProgress: (percent) => win.webContents.send('export:progress', { start, end, percent }),
    });
    shell.showItemInFolder(res.output);
    return { ok: true, output: res.output, bytes: res.size };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('app:reveal', (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

// ---- 字幕自动探测：同目录 .srt → 内嵌字幕流 → 交给 AI 字幕 ----
ipcMain.handle('subtitle:probe', async (_e, videoPath) => {
  const sidecar = subtitles.findSidecar(videoPath);
  let embedded = [];
  let hasAudio = null;
  if (ffmpegState.found) {
    const res = await subtitles.probeSubtitleStreams(videoPath, ffmpegState.path);
    embedded = res.streams;
    hasAudio = res.hasAudio;
  }
  return { sidecar: sidecar ? readSubtitleFile(sidecar.path) : null, embedded, hasAudio };
});

ipcMain.handle('subtitle:extractEmbedded', async (_e, payload) => {
  const { videoPath, streamIndex } = payload;
  if (!ffmpegState.found) return { ok: false, error: '提取内嵌字幕需要 FFmpeg。' };
  const base = path.basename(videoPath, path.extname(videoPath));
  const out = await dialog.showSaveDialog(win, {
    title: '提取内嵌字幕',
    defaultPath: path.join(path.dirname(videoPath), base + '.srt'),
    filters: [{ name: 'SubRip 字幕 (*.srt)', extensions: ['srt'] }],
  });
  if (out.canceled || !out.filePath) return { ok: false, canceled: true };
  try {
    await subtitles.extractEmbedded({
      ffmpegPath: ffmpegState.path,
      input: videoPath,
      streamIndex,
      output: out.filePath,
    });
    return { ok: true, file: readSubtitleFile(out.filePath) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// ---- 本地 Whisper（whisper.cpp）----
ipcMain.handle('whisper:detect', async () => recheckWhisper());

ipcMain.handle('whisper:pickBinary', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 whisper-cli 可执行文件',
    properties: ['openFile'],
    filters: [{ name: 'whisper-cli', extensions: ['exe', 'bin'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return whisperState;
  settings.write({ whisperPath: r.filePaths[0] });
  return recheckWhisper();
});

ipcMain.handle('whisper:pickModel', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 ggml 模型文件',
    properties: ['openFile'],
    filters: [{ name: 'Whisper 模型 (ggml-*.bin)', extensions: ['bin'] }],
  });
  if (r.canceled || !r.filePaths[0]) return whisperState;
  settings.write({ modelPath: r.filePaths[0] });
  return recheckWhisper();
});

ipcMain.handle('whisper:transcribe', async (_e, payload) => {
  const { videoPath, taskId } = payload;
  const cfg = whisper.resolveConfig(settings.read());
  if (!whisperState.found) {
    return { ok: false, error: '未检测到 whisper-cli。请解压 whisper.cpp 的 whisper-bin-x64.zip（无需编译），并在「AI 字幕 · 本地」指定 whisper-cli.exe。' };
  }
  if (!whisperState.model.found) {
    return {
      ok: false,
      error: `未找到模型 ggml-${cfg.modelSize}.bin。Whisper 不会自动下载模型，请手动下载后选择，或放到 ~/.cache/whisper.cpp。中文建议 small 及以上。`,
    };
  }
  const base = path.basename(videoPath, path.extname(videoPath));
  const outputSrt = path.join(path.dirname(videoPath), base + '.generated.srt');
  try {
    const res = await whisper.transcribe({
      taskId,
      whisperPath: whisperState.path,
      modelPath: whisperState.model.path,
      ffmpegPath: ffmpegState.path,
      input: videoPath,
      outputSrt,
      workDir: path.join(app.getPath('temp'), 'topiccut-whisper-' + taskId),
      language: cfg.language,
      threads: cfg.threads,
      durationSec: null,
      onProgress: (p) => win && win.webContents.send('whisper:progress', { taskId, ...p }),
    });
    shell.showItemInFolder(res.path);
    return { ok: true, file: readSubtitleFile(res.path), elapsedMs: res.elapsedMs };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    return { ok: false, canceled: message === '已取消。', error: message };
  }
});

ipcMain.handle('whisper:cancel', (_e, taskId) => whisper.cancel(taskId));

// ---- 1.5 AI Insight：所有出网调用都留在主进程，密钥不下发到渲染层 ----
const aiAborted = new Set();
const aiSignals = new Map();

function aiConfig() {
  return ai.resolveAiConfig(settings.read());
}

/** 给渲染层的脱敏视图：能显示"配到哪一步了"，但不含密钥本身 */
function aiStatus() {
  const cfg = aiConfig();
  return {
    provider: cfg.provider,
    endpoint: cfg.endpoint,
    model: cfg.model,
    hasKey: cfg.hasKey,
    keyTail: cfg.keyTail,
    ready: cfg.ready,
    providers: Object.entries(ai.PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      endpoint: p.endpoint,
      model: p.model,
    })),
  };
}

function sendAiProgress(taskId, p) {
  if (win && !win.isDestroyed()) win.webContents.send('ai:progress', { taskId, ...p });
}

ipcMain.handle('ai:status', () => aiStatus());

ipcMain.handle('ai:setConfig', (_e, patch) => {
  // 只写四个原始字段：派生值落盘会变成配置文件里一个说谎的 hasKey
  settings.write({ ai: ai.mergeAiConfig(settings.read().ai, patch) });
  return aiStatus();
});

ipcMain.handle('ai:test', async () => {
  try {
    return { ok: true, ...(await ai.testConnection(aiConfig())) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('ai:cancel', (_e, taskId) => {
  aiAborted.add(taskId);
  const controller = aiSignals.get(taskId);
  if (controller) controller.abort();
  return true;
});

ipcMain.handle('ai:analyzeVideo', async (_e, payload) => {
  const { cues, taskId } = payload;
  aiAborted.delete(taskId);
  const controller = new AbortController();
  aiSignals.set(taskId, controller);
  try {
    const data = await ai.analyzeVideo(cues, aiConfig(), {
      onProgress: (p) => sendAiProgress(taskId, p),
      isAborted: () => aiAborted.has(taskId),
      signal: controller.signal,
    });
    aiSignals.delete(taskId);
    aiAborted.delete(taskId);
    return { ok: true, data };
  } catch (err) {
    aiSignals.delete(taskId);
    aiAborted.delete(taskId);
    const message = String(err && err.message ? err.message : err);
    return { ok: false, canceled: message === '已取消。', error: message };
  }
});

ipcMain.handle('ai:analyzeClip', async (_e, payload) => {
  try {
    return { ok: true, data: await ai.analyzeClip(payload.cues, aiConfig()) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

/** 问题 → 关键词（模型只出词，时间轴由渲染层的 buildClips 用真实字幕算出） */
ipcMain.handle('ai:questionTerms', async (_e, payload) => {
  try {
    const { keywords } = await ai.extractQuestionTerms(payload.question, payload.cues, aiConfig());
    return { ok: true, keywords };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

/** 拿本地检索出的真实引文写答案 */
ipcMain.handle('ai:answer', async (_e, payload) => {
  try {
    return { ok: true, ...(await ai.answerFromEvidence(payload.question, payload.evidence, aiConfig())) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

/** 1.0 的「AI 扩展」改走同一条主进程通道：渲染层不再直接 fetch，任意兼容接口也不受 CORS 限制 */
ipcMain.handle('ai:expandTopic', async (_e, payload) => {
  try {
    const { keywords } = await ai.extractQuestionTerms(payload.topic, payload.cues || [], aiConfig());
    return { ok: true, keywords };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// 演示通道：只有显式 `npm run demo`（TOPICCUT_DEMO=1）才载入样例字幕；dev 与生产一律不载入
ipcMain.handle('demo:load', () => {
  if (process.env.TOPICCUT_DEMO !== '1') return null;
  const root = path.join(__dirname, '..');
  const srtPath = path.join(root, 'samples', 'demo.srt');
  if (!fs.existsSync(srtPath)) return null;

  const videoPath = [process.env.TOPICCUT_DEMO_VIDEO, path.join(root, '.selfcheck', 'topiccut-source.mp4')]
    .filter((p) => p && fs.existsSync(p))
    .shift();

  return {
    path: srtPath,
    name: 'demo.srt',
    bytes: fs.statSync(srtPath).size,
    text: fs.readFileSync(srtPath, 'utf8'),
    query: process.env.TOPICCUT_DEMO_QUERY || '人工智能',
    skipSubtitle: process.env.TOPICCUT_DEMO_NO_SUB === '1',
    video: videoPath
      ? {
          path: videoPath,
          name: path.basename(videoPath),
          dir: path.dirname(videoPath),
          bytes: fs.statSync(videoPath).size,
          mtime: fs.statSync(videoPath).mtimeMs,
          probe: null,
          mediaUrl: toMediaUrl(videoPath),
        }
      : null,
  };
});

/** 等渲染层状态满足条件（字幕探测是异步的，不能用固定延时赌） */
async function waitState(predicate, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const state = await win.webContents.executeJavaScript('window.__TOPICCUT_STATE__ || null');
    if (state && predicate(state)) return state;
    if (Date.now() > until) return state;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 自检专用：从 AI 生成的 SRT 里挑一个真实高频中文词当检索词 */
function pickQueryFromSrt(text) {
  const counts = new Map();
  for (const m of String(text).matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = m[0];
    for (let n = 2; n <= 4 && n <= run.length; n++) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const w = run.slice(i, i + n);
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }
  }
  let best = null;
  for (const [w, c] of counts) {
    if (c < 3) continue;
    const score = c * (w.length - 1);
    if (!best || score > best.score) best = { w, score };
  }
  return best ? best.w : null;
}

// 场景验证：TOPICCUT_SCENARIO=1，走真实渲染层流程验证字幕来源生命周期
async function runScenario() {
  const results = [];
  const assert = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, actual, expected });
    console.log(`${ok ? 'FLOW_PASS' : 'FLOW_FAIL'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
  };
  const fixture = (n) => path.join(__dirname, '..', '.selfcheck', n);
  const importVideo = (p) =>
    win.webContents.executeJavaScript(`window.__TOPICCUT_TEST__.importVideo(${JSON.stringify(p)})`);

  await new Promise((r) => setTimeout(r, 1500));

  // 场景 A：demo 已载入字幕 → 导入真实视频，绝不能继续携带 demo.srt
  const demoState = await waitState((s) => s.hasSubtitle === true);
  assert('A 前置：demo 模式已载入 demo.srt', demoState.subtitleName, 'demo.srt');
  const embeddedFile = fixture('topiccut-embedded.mkv');
  if (!fs.existsSync(embeddedFile)) {
    assert('A 测试素材存在', embeddedFile, '先运行 npm run verify:subtitles 生成 .selfcheck 素材');
  } else {
    // 探测是异步的，必须等渲染层把 probe 写回状态再断言（hasAudio 由 null 变 true/false 即代表探测完成）
    await importVideo(embeddedFile);
    const stateA = await waitState((s) => s.videoName === 'topiccut-embedded.mkv' && s.hasAudio !== null);
    assert('A 导入真实视频后不再携带 demo.srt', stateA.subtitleName, null);
    assert('A 导入后字幕状态被清空', stateA.hasSubtitle, false);
    assert('A 导入后重新探测到内嵌字幕', stateA.embeddedCount >= 1, true);
    assert('A 视频名已切换', stateA.videoName, 'topiccut-embedded.mkv');

    // 场景 B：内嵌字幕视频 → 状态区应显示内嵌来源，而不是任何字幕文件
    assert('B 内嵌来源未被字幕覆盖', stateA.subtitleOrigin, null);
    assert('B 未误报同目录外挂字幕', stateA.sidecarFound, false);
  }

  // 场景 C：无字幕但有音轨 → 应给出 AI 字幕入口
  const nosubFile = fixture('topiccut-nosub.mp4');
  if (fs.existsSync(nosubFile)) {
    await importVideo(nosubFile);
    const settled = await waitState((s) => s.videoName === 'topiccut-nosub.mp4' && s.hasAudio !== null);
    assert('C 无字幕', settled.hasSubtitle, false);
    assert('C 无同目录字幕', settled.sidecarFound, false);
    assert('C 无内嵌字幕', settled.embeddedCount, 0);
    assert('C 有音轨 → 显示 AI 字幕入口', settled.hasAudio, true);
  } else {
    assert('C 测试素材存在', nosubFile, '先运行 npm run verify:flow 生成素材');
  }

  // 场景 D：同目录外挂字幕 → 自动载入并标记来源为 sidecar
  const sidecarFile = fixture(path.join('sidecar', 'movie.mp4'));
  if (fs.existsSync(sidecarFile)) {
    await importVideo(sidecarFile);
    const settled = await waitState((s) => s.hasSubtitle === true && s.videoName === 'movie.mp4');
    assert('D 自动载入同目录字幕', settled.subtitleName, 'movie.srt');
    assert('D 来源标记为外挂字幕', settled.subtitleOrigin, 'sidecar');
  }

  fs.mkdirSync(path.join(__dirname, '..', '.selfcheck'), { recursive: true });

  // 场景 E：真实 whisper.cpp 端到端。只有显式给出视频路径才执行（耗时长，不进默认流程）
  const realAsr = process.env.TOPICCUT_REAL_ASR;
  if (realAsr && fs.existsSync(realAsr)) {
    const base = path.basename(realAsr, path.extname(realAsr));
    const ready = await waitState((s) => s.whisperFound === true, 30000);
    assert('E whisper-cli 已被自动发现', ready.whisperFound, true);
    assert('E ggml 模型已被自动发现', ready.whisperModelFound, true);
    console.log('FLOW_INFO E 使用模型 ' + ready.whisperModelName);

    await importVideo(realAsr);
    const settled = await waitState((s) => s.videoName === path.basename(realAsr) && s.hasAudio !== null, 120000);
    assert('E 真实视频无字幕', settled.hasSubtitle, false);
    assert('E 有音轨，AI 入口可用', settled.hasAudio, true);

    const clicked = await win.webContents.executeJavaScript('window.__TOPICCUT_TEST__.clickButton("生成 AI 字幕")');
    assert('E 点击「生成 AI 字幕」生效', clicked, true);

    const trace = [];
    const t0 = Date.now();
    const done = await waitState((s) => {
      if (s.transcribing) trace.push({ percent: s.genPercent, eta: s.genEta, stage: s.genStage });
      return s.hasSubtitle === true;
    }, 60 * 60 * 1000);
    assert('E 生成字幕文件名为 <视频名>.generated.srt', done.subtitleName, base + '.generated.srt');
    assert('E 来源标记为 AI 生成', done.subtitleOrigin, 'ai');
    assert('E 字幕非空', done.cueCount > 0, true);
    const percents = trace.map((t) => t.percent);
    const monotonic = percents.every((p, i) => i === 0 || p >= percents[i - 1]);
    assert('E 进度单调递增且采样点充足', monotonic && trace.length > 10, true);
    assert('E 进度到达过 100%', done.genMaxPercent === 100, true);
    console.log('FLOW_INFO E 转写耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，进度采样 ' + trace.length + ' 次');

    const srtPath = path.join(path.dirname(realAsr), base + '.generated.srt');
    const query = pickQueryFromSrt(fs.readFileSync(srtPath, 'utf8'));
    console.log('FLOW_INFO E 检索关键词 ' + JSON.stringify(query));
    let asrClipCount = 0;
    if (query) {
      await win.webContents.executeJavaScript(`window.__TOPICCUT_TEST__.search(${JSON.stringify(query)})`);
      const searched = await waitState((s) => s.clipCount >= 1, 30000);
      asrClipCount = searched.clipCount;
      assert('E 用生成字幕检索到候选片段', searched.clipCount >= 1, true);
      const clip = (searched.clips || [])[0];
      if (clip) {
        assert('E 片段末尾不超过视频长度', clip.end <= (settled.videoDurationSec || clip.end) + 0.01, true);
        const outFile = path.join(__dirname, '..', '.selfcheck', 'realtest', `export-${clip.id}.mp4`);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        try {
          // 与 clip:export 走同一个 ffmpeg.exportClip；仅跳过无人可点的保存对话框这一步
          const res = await ffmpeg.exportClip({
            ffmpegPath: ffmpegState.path,
            input: realAsr,
            output: outFile,
            start: clip.start,
            end: clip.end,
            onProgress: () => {},
          });
          assert('E 导出产物存在', fs.existsSync(res.output), true);
          const out = await ffmpeg.probe(outFile, ffmpegState.path);
          const wanted = clip.end - clip.start;
          const drift = Math.abs((out.duration || 0) - wanted);
          // -c copy 只能切在关键帧上：绝对偏差 2 秒内，或相对偏差 2% 内
          assert('E 导出时长与片段一致（流复制容差）', drift < 2 || drift / wanted < 0.02, true);
          console.log(
            'FLOW_INFO E 片段 ' +
              clip.start.toFixed(1) +
              's→' +
              clip.end.toFixed(1) +
              's 导出 ' +
              (out.duration || 0).toFixed(2) +
              's（偏差 ' +
              drift.toFixed(2) +
              's）/ ' +
              (res.size / 1048576).toFixed(2) +
              ' MB',
          );
        } catch (err) {
          assert('E 导出未抛错', String(err && err.message), '无');
        }
      }
    } else {
      assert('E 生成字幕里能取到高频中文词', query, '非空');
    }

    const imgE = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', '.selfcheck', 'realasr.png'), imgE.toPNG());
    fs.writeFileSync(
      path.join(__dirname, '..', '.selfcheck', 'realasr.json'),
      JSON.stringify(
        {
          video: path.basename(realAsr),
          videoDurationSec: settled.videoDurationSec ?? null,
          model: done.whisperModelName,
          transcribeElapsedMs: done.lastGenElapsedMs,
          realtimeFactor: settled.videoDurationSec && done.lastGenElapsedMs
            ? Number((settled.videoDurationSec / (done.lastGenElapsedMs / 1000)).toFixed(2))
            : null,
          progressSamples: trace.length,
          cueCount: done.cueCount,
          query: query || null,
          clipCount: asrClipCount,
        },
        null,
        2,
      ),
    );
  }

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', '.selfcheck', 'flow.png'), img.toPNG());
  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(
    path.join(__dirname, '..', '.selfcheck', 'flow.json'),
    JSON.stringify({ passed: results.length - failed, failed, results }, null, 2),
  );
  console.log(`FLOW_SUMMARY ${results.length - failed}/${results.length} 通过`);
  app.exit(failed === 0 ? 0 : 1);
}

/**
 * 1.5 AI Insight 场景：对着本地 mock 的 OpenAI 兼容接口跑完整 UI 流程。
 * 覆盖：未配置密钥、配置保存与脱敏、测试连接、全片分析、401/5xx 提示、Ask AI 定位、片段分析、取消。
 * 由 scripts/verify-ai.mjs 启动（独立 userData，不污染真实配置）。
 */
async function runAiScenario() {
  const results = [];
  const assert = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, actual, expected });
    console.log(`${ok ? 'AI_PASS' : 'AI_FAIL'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.join(__dirname, '..', '.selfcheck'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', '.selfcheck', name), img.toPNG());
  };
  const base = process.env.TOPICCUT_AI_BASE || '';
  const statsUrl = process.env.TOPICCUT_AI_STATS || '';
  const apiKey = process.env.TOPICCUT_AI_KEY || 'sk-topiccut-mock-key';
  const readStats = async () => (statsUrl ? await (await fetch(statsUrl)).json() : emptyStats());
  const emptyStats = () => ({ requests: 0, byMode: {}, answered: {}, authed: 0, promptChars: 0, sawCueText: false, models: [] });
  const waitNotice = (sub, ms) => waitState((s) => String((s.lastNotice && s.lastNotice.text) || '').includes(sub), ms || 20000);
  const setCfg = (endpoint, key) =>
    js(
      `window.__TOPICCUT_TEST__.saveAiConfig({provider:'custom',endpoint:${JSON.stringify(endpoint)},model:'mock-mini',apiKey:${JSON.stringify(key)}})`,
    );

  if (!base) {
    console.log('AI_FAIL 缺少 TOPICCUT_AI_BASE，无法跑 AI 场景（请用 npm run verify:ai）');
    app.exit(1);
    return;
  }

  await new Promise((r) => setTimeout(r, 1500));
  const endpoint = (mode) => `${base}?mode=${mode}`;

  // A：还没配密钥
  const s0 = await waitState((s) => s.hasSubtitle === true);
  assert('A 前置：demo.srt 已载入', s0.subtitleName, 'demo.srt');
  assert('A 未配置时 AI 能力保持禁用', s0.aiReady, false);
  const before = await readStats();
  await js('window.__TOPICCUT_TEST__.analyzeVideo()');
  const noticeA = await waitNotice('尚未配置');
  assert('A 未配置密钥时给出可读提示', String(noticeA.lastNotice && noticeA.lastNotice.text).includes('尚未配置'), true);
  assert('A 未配置密钥时一次请求都没发', (await readStats()).requests, before.requests);

  // B：设置页等价操作——保存配置 + 测试连接（真实 HTTP）
  const saved = await setCfg(endpoint('ok'), apiKey);
  assert('B 保存后 AI 就绪', saved.ready, true);
  assert('B 模型名取自用户输入', saved.model, 'mock-mini');
  assert('B endpoint 已归一成 chat/completions', String(saved.endpoint).endsWith('/chat/completions'), true);
  assert('B 界面只显示密钥末 4 位', [saved.hasKey, saved.keyTail], [true, apiKey.slice(-4)]);
  assert('B 返回给渲染层的视图里没有密钥原文', JSON.stringify(saved).includes(apiKey), false);
  const renderedB = await waitState((s) => s.aiReady === true);
  assert('B 渲染层状态里没有密钥原文', JSON.stringify(renderedB).includes(apiKey), false);
  const testText = await js('window.__TOPICCUT_TEST__.testAi()');
  assert('B 测试连接返回成功文案', String(testText).includes('连接成功'), true);
  const bStats = await readStats();
  assert('B 测试连接真的发出了请求', bStats.requests, 1);
  assert('B 请求带上的是本机保存的密钥', bStats.authed, 1);
  assert('B 顶栏「设置」可打开', await js('window.__TOPICCUT_TEST__.clickButton("设置")'), true);
  await waitState((s) => s.settingsOpen === true);
  assert('B 设置页只显示密钥末 4 位', await js('document.querySelector("input[type=password]").placeholder.includes("末 4 位 9f2c")'), true);
  assert('B 设置页不回显密钥原文', await js('document.body.innerHTML.includes(' + JSON.stringify(apiKey) + ')'), false);
  await shot('ai-settings.png');
  await js('window.__TOPICCUT_TEST__.clickButton("关闭")');
  await waitState((s) => s.settingsOpen === false);

  // C：全片分析（分块 → 逐段 → 汇总）
  const okBefore = (await readStats()).byMode.ok || 0;
  assert('C 点击「分析全片」生效', await js('window.__TOPICCUT_TEST__.clickButton("分析全片")'), true);
  const doneC = await waitState((s) => s.aiHasInsight === true, 60000);
  assert('C 产出视频摘要', String(doneC.aiSummary || '').length > 0, true);
  assert('C 章节时间取字幕真实边界', doneC.aiChapters[0][0], 80);
  assert('C 章节末不越过最后一条字幕', doneC.aiChapters[doneC.aiChapterCount - 1][1] <= 753.0, true);
  assert('C 主要主题 / 关键词非空', [doneC.aiThemeCount > 0, doneC.aiKeywordCount > 0], [true, true]);
  const cStats = await readStats();
  assert(
    'C 请求次数 = 分段数 +（多段时）一次汇总',
    (cStats.byMode.ok || 0) - okBefore,
    doneC.aiChunks + (doneC.aiChunks > 1 ? 1 : 0),
  );
  assert('C 送出去的是字幕正文', cStats.sawCueText, true);
  console.log(
    'AI_INFO C 分段 ' +
      doneC.aiChunks +
      ' 段 / 章节 ' +
      doneC.aiChapterCount +
      ' 个 / 累计请求体 ' +
      cStats.promptChars +
      ' 字符',
  );

  // D：接口失败的提示（401 / 5xx）
  await setCfg(endpoint('auth'), 'sk-bad-key');
  await js('window.__TOPICCUT_TEST__.clickButton("分析全片")');
  assert('D 401 提示归因到密钥', String((await waitNotice('API Key 无效')).lastNotice.text).includes('API Key 无效'), true);
  assert('D 失败时不假装分析仍在进行', (await waitState((s) => s.aiAnalyzing === false)).aiAnalyzing, false);
  await setCfg(endpoint('err'), 'sk-bad-key');
  await js('window.__TOPICCUT_TEST__.clickButton("分析全片")');
  assert('D 5xx 提示为服务端错误', String((await waitNotice('AI 服务端错误')).lastNotice.text).includes('AI 服务端错误（500）'), true);

  // E：Ask AI —— 模型只出词，片段与时间由本地字幕检索给出
  await setCfg(endpoint('ok'), apiKey);
  await js('window.__TOPICCUT_TEST__.ask("这段视频主要在讲什么？")');
  const doneE = await waitState((s) => s.askAnswer != null, 60000);
  assert('E 检索词来自模型', doneE.askKeywords, ['人工智能', '内容']);
  assert('E 检索词在真实字幕里定位到片段', doneE.askClips >= 1, true);
  assert('E 定位结果同步进片段列表', doneE.clipCount, doneE.askClips);
  assert('E 模型编造的时间码被清除', String(doneE.askAnswer).includes('02:10'), false);
  assert('E 清洗后指回真实片段列表', String(doneE.askAnswer).includes('以左侧真实片段列表为准'), true);

  // 问答可信度：界面上的每条证据都要能在真实字幕文件里逐字找到，模型编的时间码不许上界面
  const srtRaw = fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo.srt'), 'utf8');
  const evidenceLines = await js(
    `Array.from(document.querySelectorAll('.clip-card')).flatMap((el) => Array.from(el.querySelectorAll('p')).map((p) => p.innerText.trim()).filter((t) => /^\\d\\d:\\d\\d/.test(t)))`,
  );
  assert('E 片段卡给出了字幕证据', evidenceLines.length > 0, true);
  console.log('AI_INFO E 证据行样例 ' + JSON.stringify(evidenceLines.slice(0, 2)));
  assert(
    'E 界面上每条证据都逐字来自真实字幕文件',
    evidenceLines.length > 0 && evidenceLines.every((l) => srtRaw.includes(l.replace(/^\d\d:(\d\d:)?\d\d/, '').replace(/…$/, ''))),
    true,
  );
  assert('E 模型编造的 02:10 没有出现在任何片段时间上', await js(`Array.from(document.querySelectorAll('.clip-card')).every((el) => !el.innerText.includes('02:10'))`), true);
  assert('E 界面把 AI 回答标成"只依据本地检索到的字幕"', await js('document.body.innerText.includes("AI 回答 · 只依据下面这些本地检索到的字幕")'), true);

  // F：片段级 AI 分析
  await js('window.__TOPICCUT_TEST__.search("人工智能")');
  const beforeF = await waitState((s) => s.clipCount >= 1);
  assert('F 片段卡提供分析入口', await js('window.__TOPICCUT_TEST__.clickButton("AI 分析")'), true);
  const doneF = await waitState((s) => (s.aiClipInsightIds || []).length >= 1, 60000);
  assert('F 结论挂在对的片段上', (doneF.aiClipInsightIds || []).length, 1);
  assert('F 片段结论渲染到界面', await js('document.body.innerText.includes("这段适合作为开场钩子")'), true);
  assert(
    'F 字幕原文 / AI 概括 / AI 推断在界面上分开标注',
    await js('["内容总结 · AI 概括","推荐用途 · AI 推断","字幕证据 · 原文"].every((t) => document.body.innerText.includes(t))'),
    true,
  );

  // 文档截图要的是正常状态：D 组的故意失败会把结论标成"过期"，先跑一次成功的分析把它清掉
  await js('window.__TOPICCUT_TEST__.clickButton("分析全片")');
  await waitNotice('AI 全片分析完成', 60000);
  assert('截图前状态已回到"最近一次分析成功"', (await waitState((s) => s.insightStale === false)).insightStale, false);

  // 截图前先让提示气泡自己消失，免得挡住正文
  await new Promise((r) => setTimeout(r, 7500));
  await js('document.querySelector("main").scrollTo({top:0,behavior:"instant"})');
  await shot('ai.png');
  await js('document.querySelectorAll(".clip-card")[0].scrollIntoView({block:"start",behavior:"instant"})');
  await new Promise((r) => setTimeout(r, 400));
  await shot('ai-clip.png');

  // G：取消——掐掉正在飞的请求，而不是干等
  await setCfg(endpoint('slow'), apiKey);
  const slowAnswered = (await readStats()).answered.slow || 0;
  await js('window.__TOPICCUT_TEST__.clickButton("分析全片")');
  await waitState((s) => s.aiAnalyzing === true, 8000);
  assert('G 分析期间可取消', await js('window.__TOPICCUT_TEST__.clickButton("取消")'), true);
  const doneG = await waitNotice('已取消。');
  assert('G 取消以「已取消」结束', String(doneG.lastNotice.text), '已取消。');
  assert('G 取消后请求未被服务端回复过', (await readStats()).answered.slow || 0, slowAnswered);
  assert('G 取消后回到空闲', (await waitState((s) => s.aiAnalyzing === false)).aiAnalyzing, false);

  // H：1.0 的「AI 扩展」按钮 —— 1.5 之后它和 Insight 走同一条主进程通道，渲染层不再直接 fetch
  await setCfg(endpoint('ok'), apiKey);
  const hBefore = (await readStats()).requests;
  await js('window.__TOPICCUT_TEST__.search("人工智能怎样改变内容行业的工作方式")');
  await new Promise((r) => setTimeout(r, 300));
  assert('H 界面上的「AI 扩展」按钮可点', await js('window.__TOPICCUT_TEST__.clickButton("AI 扩展")'), true);
  const doneH = await waitState((s) => s.expanding === false && s.clipCount > 0, 60000);
  assert('H 扩展真的发出了请求', (await readStats()).requests - hBefore, 1);
  assert('H 关键词回填进搜索框', doneH.searchQuery, '人工智能，内容');
  assert('H 扩展结果直接复用原有检索', doneH.clipCount, 4);

  // I：删除密钥 —— 撤销必须真的可执行，撤销后入口自动禁用且零出网
  await js('window.__TOPICCUT_TEST__.clickButton("设置")');
  await waitState((s) => s.settingsOpen === true);
  const iBefore = (await readStats()).requests;
  assert('I 设置页提供「删除密钥」入口', await js('window.__TOPICCUT_TEST__.clickButton("删除密钥")'), true);
  const doneI = await waitState((s) => s.aiReady === false, 20000);
  assert('I 删除后 AI 就绪变假', doneI.aiReady, false);
  assert('I 删除后末 4 位不再留在界面状态里', doneI.aiKeyTail, null);
  await js('window.__TOPICCUT_TEST__.clickButton("关闭")');
  await waitState((s) => s.settingsOpen === false);
  assert('I 删除后分析入口自动禁用', await js('window.__TOPICCUT_TEST__.clickButton("分析全片")'), false);
  assert('I 删除后一次请求都没发', (await readStats()).requests, iBefore);
  // 重新配置后必须立刻恢复可用（改配置 → 生效，不需要重启）
  await setCfg(endpoint('ok'), apiKey);
  assert('I 重新填入密钥后恢复就绪', (await waitState((s) => s.aiReady === true)).aiReady, true);
  assert('I 恢复后分析入口重新可点', await js('window.__TOPICCUT_TEST__.clickButton("分析全片")'), true);
  const doneI2 = await waitNotice('AI 全片分析完成', 60000);
  assert('I 恢复后分析真的跑完并给出结论', String(doneI2.lastNotice.text).includes('AI 全片分析完成'), true);
  assert('I 恢复后确实又发出了请求', (await readStats()).requests > iBefore, true);

  // J：长字幕（2000 条）在真实界面里跑一遍 —— 分块、汇总次数、"读粗"标注、不丢字幕
  const longVideo = process.env.TOPICCUT_LONG_VIDEO;
  const longCues = Number(process.env.TOPICCUT_LONG_CUES) || 2000;
  const longChars = Number(process.env.TOPICCUT_LONG_CHARS) || 0;
  if (longVideo) {
    await js(`window.__TOPICCUT_TEST__.importVideo(${JSON.stringify(longVideo)})`);
    const doneJ = await waitState((s) => s.cueCount >= longCues, 30000);
    assert('J 长字幕由同目录探测自动载入', doneJ.cueCount >= longCues, true);
    assert('J 载入的是同目录 .srt', String(doneJ.subtitleName).endsWith('topiccut-long.srt'), true);
    const jBeforeReq = (await readStats()).requests;
    const jBeforeChars = (await readStats()).promptChars;
    assert('J 长片可点「分析全片」', await js('window.__TOPICCUT_TEST__.clickButton("分析全片")'), true);
    const doneJ2 = await waitNotice('AI 全片分析完成', 120000);
    const jStats = await readStats();
    const segs = doneJ2.aiChunks;
    assert('J 分段数落在预算上限内', segs >= 2 && segs <= 12, true);
    assert('J 章节数 = 分段数', doneJ2.aiChapterCount, segs);
    assert('J 请求数 = 分段数 + 一次汇总', jStats.requests - jBeforeReq, segs + 1);
    assert('J 送出的字符量覆盖整份字幕（无静默丢弃）', jStats.promptChars - jBeforeChars >= longChars, true);
    assert('J 超限被如实标注为"章节粒度变粗"', await js('document.body.innerText.includes("章节粒度相应变粗")'), true);
    console.log('AI_INFO J 分段 ' + segs + ' / 送出字符 ' + (jStats.promptChars - jBeforeChars) + '（字幕本体 ' + longChars + '）');
  } else {
    console.log('AI_INFO J 未提供 TOPICCUT_LONG_VIDEO，本组未执行（不计入通过）');
  }

  // K：跑到一半某一段失败 —— 必须立刻停手、如实报错，旧结论保留但明确标注为上次结果
  const kSummaryBefore = (await waitState((s) => s.aiHasInsight === true)).aiSummary;
  await setCfg(endpoint('flaky'), apiKey);
  const kBeforeReq = (await readStats()).requests;
  assert('K 长片可再次点「分析全片」', await js('window.__TOPICCUT_TEST__.clickButton("分析全片")'), true);
  const noticeK = await waitNotice('AI 服务端错误（500）', 120000);
  assert('K 单块失败会如实报告服务端错误', String(noticeK.lastNotice.text).includes('AI 服务端错误（500）'), true);
  assert('K 失败后不再假装分析进行中', (await waitState((s) => s.aiAnalyzing === false)).aiAnalyzing, false);
  assert('K 失败后立即停止，没有烧完剩余段', (await readStats()).requests - kBeforeReq, 3);
  const doneK = await waitState((s) => s.insightStale === true, 20000);
  assert('K 旧结论被标注为过期', doneK.insightStale, true);
  assert('K 界面上能看到「上一次成功时的结论」提示', await js('document.body.innerText.includes("上一次成功时的结论")'), true);
  assert('K 旧结论没有在半途被清空或改写', doneK.aiSummary, kSummaryBefore);
  await js('document.querySelector("main").scrollTo({top:0,behavior:"instant"})');
  await shot('ai-stale.png');

  // L：问答可信度 —— 关键词对不上字幕时，证据就是空的：不编答案，也不再花第二次调用
  await setCfg(endpoint('dead'), apiKey);
  const lBeforeReq = (await readStats()).requests;
  await js('window.__TOPICCUT_TEST__.ask("这段视频讲过火箭发动机的低温燃料吗？")');
  const doneL = await waitState((s) => s.askAnswer != null && s.asking === false, 60000);
  assert('L 无证据时如实回答无法回答', String(doneL.askAnswer).includes('无法回答'), true);
  assert('L 无证据时不给出任何片段', doneL.clipCount, 0);
  assert('L 无证据时不再向模型要答案（只花一次调用）', (await readStats()).requests - lBeforeReq, 1);
  assert('L 界面提示没有可展示的片段', await js('document.body.innerText.includes("没有可展示的片段")'), true);
  assert('L 无证据时不拿无关字幕凑成答案', String(doneL.askAnswer).includes('字幕里没有检索到'), true);

  // 设置页的文档截图：选一次预置厂商，看 endpoint/模型名是否被填进输入框（不会发请求）
  await new Promise((r) => setTimeout(r, 7500)); // 等提示条自己消失，截图才是干净的界面
  await js('window.__TOPICCUT_TEST__.clickButton("设置")');
  await waitState((s) => s.settingsOpen === true);
  await js('window.__TOPICCUT_TEST__.clickButton("DeepSeek")');
  await new Promise((r) => setTimeout(r, 400));
  await shot('ai-settings-clean.png');
  assert('预置厂商只是填表', await js('document.querySelector("input[type=password]").value'), '');

  fs.mkdirSync(path.join(__dirname, '..', '.selfcheck'), { recursive: true });
  const failed = results.filter((r) => !r.ok).length;
  fs.writeFileSync(
    path.join(__dirname, '..', '.selfcheck', 'ai.json'),
    JSON.stringify({ passed: results.length - failed, failed, results, finalState: await win.webContents.executeJavaScript('window.__TOPICCUT_STATE__') }, null, 2),
  );
  console.log(`AI_SUMMARY ${results.length - failed}/${results.length} 通过`);
  app.exit(failed === 0 ? 0 : 1);
}

// 开发自检：TOPICCUT_SHOT=1 时启动后自动截图并输出渲染层状态
async function selfCheck() {
  await new Promise((r) => setTimeout(r, 5000));
  const state = await win.webContents.executeJavaScript('window.__TOPICCUT_STATE__ || null');
  fs.mkdirSync(path.join(__dirname, '..', '.selfcheck'), { recursive: true });
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', '.selfcheck', 'shot.png'), img.toPNG());
  fs.writeFileSync(
    path.join(__dirname, '..', '.selfcheck', 'report.json'),
    JSON.stringify({ rendered: !!state, state, ffmpeg: ffmpegState, whisper: whisperState }, null, 2),
  );
  console.log('SELFCHECK ' + JSON.stringify({ rendered: !!state, ffmpeg: ffmpegState, whisper: whisperState }));
  app.exit(0);
}

app.whenReady().then(async () => {
  settings = new SettingsStore();
  // 自检专用：测试脚本可指定模型档位/语言，等价于用户在「AI 字幕 · 本地」里选择
  if (SCENARIO && (process.env.TOPICCUT_REAL_ASR_MODEL || process.env.TOPICCUT_REAL_ASR_LANG)) {
    const w = settings.read().whisper || {};
    settings.write({
      whisper: {
        ...w,
        modelSize: process.env.TOPICCUT_REAL_ASR_MODEL || w.modelSize || 'base',
        language: process.env.TOPICCUT_REAL_ASR_LANG || w.language || 'auto',
      },
    });
  }
  protocol.handle('topiccut-media', (request) => {
    const rel = decodeURIComponent(request.url.replace('topiccut-media:///', ''));
    const local = process.platform === 'win32' ? rel.replace(/\//g, '\\') : rel;
    if (!fs.existsSync(local)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(local).toString(), { bypassCustomProtocolHandlers: true });
  });
  await recheckFfmpeg();
  await recheckWhisper();
  createWindow();
  if (process.env.TOPICCUT_SHOT === '1') selfCheck();
  if (SCENARIO_MODE === 'ai') runAiScenario();
  else if (SCENARIO) runScenario();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
