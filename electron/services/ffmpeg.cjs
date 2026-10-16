const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 打包环境随包运行时目录（electron-builder 的 extraResources 落在 resources/runtime 下）。
// 这里刻意不 require('electron')：本模块要能被纯 Node 测试直接加载。
const RUNTIME_DIR = process.resourcesPath ? path.join(process.resourcesPath, 'runtime') : null;

const COMMON_PATHS = [
  process.env.FFMPEG_PATH,
  RUNTIME_DIR && path.join(RUNTIME_DIR, 'ffmpeg', 'ffmpeg.exe'),
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Links/ffmpeg.exe'),
  path.join(process.env.PROGRAMFILES || '', 'ffmpeg/bin/ffmpeg.exe'),
  // 开发期回退：npm i -D ffmpeg-static（不打包进产品，仅本机验证用）
  path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
  'ffmpeg',
].filter(Boolean);

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, ...opts });
    } catch (err) {
      resolve({ ok: false, error: err, stdout: '', stderr: String(err && err.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout && child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr && child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, error: err, stdout, stderr: stderr + String(err.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function detect(customPath) {
  const candidates = customPath ? [customPath, ...COMMON_PATHS] : COMMON_PATHS;
  for (const bin of candidates) {
    if (bin !== 'ffmpeg' && !fs.existsSync(bin)) continue;
    const res = await run(bin, ['-hide_banner', '-version']);
    if (res.ok && /ffmpeg version/i.test(res.stdout + res.stderr)) {
      const firstLine = (res.stdout || res.stderr).split('\n')[0].trim();
      return { found: true, path: bin, version: firstLine };
    }
  }
  const shellRes = await run('ffmpeg', ['-hide_banner', '-version'], { shell: true });
  if (shellRes.ok && /ffmpeg version/i.test(shellRes.stdout + shellRes.stderr)) {
    return { found: true, path: 'ffmpeg', version: (shellRes.stdout || shellRes.stderr).split('\n')[0].trim() };
  }
  return { found: false, path: null, version: null };
}

function parseTime(line) {
  const m = /out_time=(\d+):(\d+):(\d+)\.(\d+)/.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number('0.' + m[4]);
}

function buildExportArgs({ input, output, start, end }) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', String(start),
    '-to', String(end),
    '-i', input,
    '-c', 'copy',
    '-progress', 'pipe:1',
    output,
  ];
}

function exportClip({ ffmpegPath, input, output, start, end, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = buildExportArgs({ input, output, start, end });
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      reject(new Error('无法启动 FFmpeg：' + err.message));
      return;
    }
    let stderr = '';
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      const t = parseTime(text);
      if (t !== null && onProgress) onProgress(Math.min(1, t / Math.max(0.001, end - start)));
    });
    child.on('error', (err) => reject(new Error('FFmpeg 进程错误：' + err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve({ output, size: fs.existsSync(output) ? fs.statSync(output).size : 0 });
      else reject(new Error('FFmpeg 退出码 ' + code + '\n' + stderr.slice(-800)));
    });
  });
}

async function probe(inputPath, ffmpegPath) {
  const probeBin = ffmpegPath === 'ffmpeg' ? 'ffprobe' : path.join(path.dirname(ffmpegPath), path.basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe'));
  const res = await run(probeBin, [
    '-hide_banner', '-loglevel', 'error',
    '-show_entries', 'format=duration,size,bit_rate:stream=width,height,codec_name',
    '-of', 'default=noprint_wrappers=1',
    inputPath,
  ]);
  if (res.ok) {
    const info = {};
    for (const line of (res.stdout || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) info[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      duration: info.duration ? Number(info.duration) : null,
      size: info.size ? Number(info.size) : null,
      bitrate: info.bit_rate ? Number(info.bit_rate) : null,
      width: info.width ? Number(info.width) : null,
      height: info.height ? Number(info.height) : null,
      vcodec: info.codec_name || null,
    };
  }

  // 没有 ffprobe 时退回解析 `ffmpeg -i` 的 Duration 行
  const fallback = await run(ffmpegPath, ['-hide_banner', '-i', inputPath]);
  const text = (fallback.stdout || '') + (fallback.stderr || '');
  const dur = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(text);
  const size = /video:\s*(\d+) KiB/.exec(text);
  const wh = /(\d{2,5})x(\d{2,5})[ ,]/.exec(text);
  if (!dur && !wh) return null;
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) + Number('0.' + dur[4]) : null,
    size: size ? Number(size[1]) * 1024 : null,
    bitrate: null,
    width: wh ? Number(wh[1]) : null,
    height: wh ? Number(wh[2]) : null,
    vcodec: null,
  };
}

module.exports = { detect, exportClip, probe, buildExportArgs, parseTime, run };
