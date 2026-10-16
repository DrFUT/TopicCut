const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('./ffmpeg.cjs');
const { hasAudioStream } = require('./subtitles.cjs');

const MODEL_SIZES = ['tiny', 'base', 'small', 'medium'];

/**
 * 纯函数：把设置归一成转写参数。
 * 渲染层把 AI 字幕设置存成 settings.whisper.{modelSize,language,threads}，
 * 主进程必须读这个嵌套对象——历史上读过扁平的 cfg.modelSize，导致界面上换档位完全无效。
 */
function resolveConfig(cfg) {
  const w = (cfg && cfg.whisper) || {};
  return {
    modelSize: MODEL_SIZES.includes(w.modelSize) ? w.modelSize : 'base',
    language: w.language || 'auto',
    threads: Number(w.threads) > 0 ? Number(w.threads) : 4,
    modelPath: (cfg && cfg.modelPath) || null,
    whisperPath: (cfg && cfg.whisperPath) || null,
  };
}

function whisperCandidates(customPath) {
  const local = process.env.LOCALAPPDATA || '';
  // 随包 whisper-cli（extraResources → resources/runtime/whisper）：只带 CLI 与必需 DLL，模型仍由用户自备
  const bundled = process.resourcesPath
    ? path.join(process.resourcesPath, 'runtime', 'whisper', 'whisper-cli.exe')
    : null;
  return [
    customPath,
    process.env.WHISPER_PATH,
    bundled,
    'C:\\whisper.cpp\\build\\bin\\Release\\whisper-cli.exe',
    'C:\\whisper.cpp\\build\\bin\\Release\\main.exe',
    'C:\\Program Files\\whisper.cpp\\whisper-cli.exe',
    path.join(local, 'Programs\\whisper.cpp\\whisper-cli.exe'),
    path.join(__dirname, '..', '..', 'whisper.cpp', 'whisper-cli.exe'),
    'whisper-cli',
    'whisper',
  ].filter(Boolean);
}

function modelCandidates({ modelPath, whisperPath, size }) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const file = `ggml-${MODEL_SIZES.includes(size) ? size : 'base'}.bin`;
  const dirs = [];
  if (whisperPath) {
    const bin = path.dirname(whisperPath);
    dirs.push(path.join(bin, 'models'), path.join(bin, '..', 'models'), path.join(bin, '..', '..', 'models'));
  }
  dirs.push(
    path.join(home, 'Downloads'),
    path.join(home, '.cache', 'whisper.cpp'),
    'C:\\whisper.cpp\\models',
    path.join(__dirname, '..', '..', 'models'),
  );
  return [modelPath, ...dirs.map((d) => path.join(d, file))].filter(Boolean);
}

/** 纯函数：输出看起来像真的 whisper-cli 帮助页，而不是 `spawn whisper-cli ENOENT` 这类包含命令名的报错 */
function looksLikeWhisperHelp(text) {
  return /whisper/i.test(text) && /usage|available arguments|options|--model|-osrt/i.test(text);
}

async function detect(customPath) {
  for (const bin of whisperCandidates(customPath)) {
    if (bin !== 'whisper-cli' && bin !== 'whisper' && !fs.existsSync(bin)) continue;
    const res = await run(bin, ['--help']);
    const text = (res.stdout || '') + (res.stderr || '');
    if (looksLikeWhisperHelp(text)) {
      // --help 不带版本号，再跑一次 --version，让界面能显示真实版本
      let version = /whisper\.cpp version[^\n]*/i.exec(text)?.[0]?.trim() || null;
      if (!version && bin !== 'whisper-cli' && bin !== 'whisper') {
        const vres = await run(bin, ['--version']);
        version = /whisper\.cpp version[^\n]*/i.exec((vres.stdout || '') + (vres.stderr || ''))?.[0]?.trim() || null;
      }
      return { found: true, path: bin, version };
    }
  }
  const shellRes = await run('whisper-cli', ['--help'], { shell: true });
  if (looksLikeWhisperHelp((shellRes.stdout || '') + (shellRes.stderr || ''))) {
    return { found: true, path: 'whisper-cli', version: null };
  }
  return { found: false, path: null, version: null };
}

function statModel(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 1024 * 1024) return null;
    return { found: true, path: p, name: path.basename(p), bytes: st.size };
  } catch {
    return null;
  }
}

function detectModel(opts) {
  for (const p of modelCandidates(opts)) {
    const info = statModel(p);
    if (info) return info;
  }
  return { found: false, path: null, name: null, bytes: 0 };
}

/** 纯函数：whisper-cli 转写参数（不传进度开关，兼容新旧版本） */
function buildTranscribeArgs({ model, audio, outBase, language, threads }) {
  const args = ['-m', model, '-f', audio, '-of', outBase, '-osrt'];
  if (language && language !== 'auto') args.push('-l', language);
  if (threads) args.push('-t', String(threads));
  return args;
}

/** 纯函数：ffmpeg 抽音轨参数（Whisper 只吃 16kHz 单声道 wav） */
function buildAudioArgs({ input, output }) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-sn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', output];
}

function hmsToSeconds(raw) {
  const m = /(\d+):(\d+):(\d+)[.,](\d+)/.exec(String(raw));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]);
}

/**
 * 纯函数：从 whisper 输出里解析进度。
 * 优先 `progress = 12.34 / 56.78 secs ( 2.10 x)`；
 * 退化时用已识别到的最后一条分段结束时间 / 音频总时长。
 */
function parseProgress(chunk, durationSec) {
  let ratio = null;
  let doneSec = null;
  let totalSec = null;
  let speed = null;

  const p = /progress\s*=\s*([\d.]+)\s*\/\s*([\d.]+)\s*secs(?:\s*\(\s*([\d.]+)\s*x\s*\))?/g;
  let m;
  while ((m = p.exec(chunk))) {
    doneSec = Number(m[1]);
    totalSec = Number(m[2]);
    if (m[3]) speed = Number(m[3]);
    ratio = totalSec > 0 ? Math.min(1, doneSec / totalSec) : ratio;
  }

  if (ratio === null && durationSec > 0) {
    const seg = /\[(\d+:\d+:\d+[.,]\d+)\s*-->/g;
    let last = null;
    let s;
    while ((s = seg.exec(chunk))) {
      const t = hmsToSeconds(s[1]);
      if (t !== null && t > 0) last = t;
    }
    if (last !== null) {
      ratio = Math.min(0.99, last / durationSec);
      doneSec = last;
      totalSec = durationSec;
    }
  }

  const eta = doneSec !== null && speed && speed > 0 && totalSec !== null ? Math.max(0, (totalSec - doneSec) / speed) : null;
  return { ratio, eta, doneSec, totalSec, speed };
}

const tasks = new Map();

function cancel(taskId) {
  const entry = tasks.get(taskId);
  if (!entry) return false;
  entry.cancelled = true;
  try {
    entry.child.kill();
  } catch {
    /* 进程已退出 */
  }
  return true;
}

/** 起进程、解析进度、支持 kill；bin/args 由调用方给出，便于替换为不同发行版的可执行文件 */
function runWhisper({ taskId, bin, args, durationSec, onTick }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      reject(new Error('无法启动 whisper-cli：' + err.message));
      return;
    }
    const entry = { child, cancelled: false };
    tasks.set(taskId, entry);

    let tail = '';
    let buffer = '';
    const onData = (buf) => {
      const chunk = buf.toString();
      tail = (tail + chunk).slice(-4000);
      buffer = (buffer + chunk).slice(-8000);
      const parsed = parseProgress(buffer, durationSec);
      if (parsed.ratio !== null) onTick(parsed.ratio, parsed.eta);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      tasks.delete(taskId);
      reject(new Error('无法启动 whisper-cli：' + err.message));
    });
    child.on('close', (code) => {
      tasks.delete(taskId);
      if (entry.cancelled) reject(new Error('已取消。'));
      else if (code !== 0) reject(new Error(`Whisper 退出码 ${code}：${tail.trim().slice(-300) || '识别失败'}`));
      else resolve(tail);
    });
  });
}

async function transcribe({
  taskId,
  whisperPath,
  modelPath,
  ffmpegPath,
  input,
  outputSrt,
  workDir,
  language,
  threads,
  durationSec,
  onProgress,
}) {
  if (!whisperPath || !fs.existsSync(whisperPath)) {
    throw new Error('未找到 whisper-cli。请解压 whisper.cpp releases 的 whisper-bin-x64.zip（免编译），并在「AI 字幕 · 本地」指定 whisper-cli.exe 路径。');
  }
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error('未找到模型文件。请在「AI 字幕 · 本地」选择 ggml-*.bin（tiny/base/small/medium），或放入 ~/.cache/whisper.cpp；首次需手动下载。');
  }

  const started = Date.now();
  fs.mkdirSync(workDir, { recursive: true });
  const audio = path.join(workDir, 'audio.wav');
  const outBase = path.join(workDir, 'topiccut');

  const report = (ratio, eta, stage) => {
    if (ratio === null) return;
    try {
      onProgress({ percent: Math.round(ratio * 100), eta, stage: stage || (ratio >= 1 ? '收尾' : '识别') });
    } catch {
      /* 渲染层已断开 */
    }
  };

  try {
    // 1) 先确认有音轨，避免白跑几十分钟
    const info = await run(ffmpegPath, ['-hide_banner', '-i', input]);
    const text = (info.stdout || '') + (info.stderr || '');
    const dur = /Duration:\s*(\d+:\d+:\d+[.,]\d+)/.exec(text);
    if (dur && !durationSec) durationSec = hmsToSeconds(dur[1]);
    if (!hasAudioStream(text)) {
      throw new Error('这个视频没有音轨，Whisper 无法识别。请确认源文件包含声音流。');
    }

    // 2) 抽 16kHz 单声道 wav：whisper.cpp 只吃这个格式，自己抽还能提前失败
    report(0.01, null, '检查音轨');
    const audioRes = await run(ffmpegPath, buildAudioArgs({ input, output: audio }));
    if (!audioRes.ok || !fs.existsSync(audio) || fs.statSync(audio).size < 1024) {
      throw new Error('音频提取失败：' + ((audioRes.stderr || '').trim().slice(-300) || 'FFmpeg 未能读出音轨'));
    }
    report(0.05, null, '提取音轨');

    // 3) 转写
    const args = buildTranscribeArgs({ model: modelPath, audio, outBase, language, threads });
    const tail = await runWhisper({
      taskId,
      bin: whisperPath,
      args,
      durationSec: durationSec || 0,
      onTick: (ratio, eta) => report(0.05 + ratio * 0.9, eta),
    });

    // 4) 取回生成的 SRT（不同版本 -of 命名略有差异，取工作目录里最新的 .srt）
    const produced = fs
      .readdirSync(workDir)
      .filter((n) => n.toLowerCase().endsWith('.srt'))
      .map((n) => ({ n, mtime: fs.statSync(path.join(workDir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!produced) throw new Error('Whisper 运行结束但没有产出 SRT 文件。');

    const generated = fs.readFileSync(path.join(workDir, produced.n), 'utf8');
    if (!/\d{2}:\d{2}:\d{2}/.test(generated)) {
      throw new Error('生成的字幕为空或没有时间轴，可能是视频无人声或语言选择不匹配。');
    }
    fs.mkdirSync(path.dirname(outputSrt), { recursive: true });
    fs.writeFileSync(outputSrt, generated.replace(/^\uFEFF/, ''), 'utf8');
    report(1, 0);

    return {
      path: outputSrt,
      name: path.basename(outputSrt),
      bytes: fs.statSync(outputSrt).size,
      text: generated.replace(/^\uFEFF/, ''),
      elapsedMs: Date.now() - started,
      audioBytes: fs.statSync(audio).size,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  MODEL_SIZES,
  resolveConfig,
  detect,
  looksLikeWhisperHelp,
  detectModel,
  buildTranscribeArgs,
  buildAudioArgs,
  parseProgress,
  runWhisper,
  transcribe,
  cancel,
};
