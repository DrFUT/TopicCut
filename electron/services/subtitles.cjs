const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./ffmpeg.cjs');

const SIDECAR_EXT = '.srt';

/** 纯函数：从同目录文件名里挑出可匹配该视频的字幕文件名，精确同名优先，其次带后缀的 */
function matchSidecarNames(fileNames, videoBase) {
  const lower = videoBase.toLowerCase();
  const hits = [];
  for (const name of fileNames) {
    const ext = path.extname(name).toLowerCase();
    if (ext !== SIDECAR_EXT) continue;
    const stem = name.slice(0, -SIDECAR_EXT.length);
    const l = stem.toLowerCase();
    if (l === lower) hits.push({ name, rank: 0 });
    else if (l.startsWith(lower + '.') || l.startsWith(lower + '-') || l.startsWith(lower + '_')) hits.push({ name, rank: 1 });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return hits.map((h) => h.name);
}

/**
 * 纯函数：解析 `ffmpeg -i` 的流列表。
 * mp4 会写成 `Stream #0:1[0x2](und): Audio:`，mkv 写成 `Stream #0:2(spa): Subtitle:`，
 * 中间那个 `[0x..]` 可有可无，漏掉它会把 mp4 的音轨全部判没。
 */
function parseStreams(text) {
  const out = [];
  const re = /Stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle|Data): (\S+)/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ file: Number(m[1]), index: Number(m[2]), lang: m[3] || null, type: m[4], codec: m[5] });
  }
  return out;
}

/** 纯函数：视频内嵌字幕流 */
function parseSubtitleStreams(text) {
  return parseStreams(text)
    .filter((s) => s.type === 'Subtitle')
    .map(({ index, lang, codec }) => ({ index, lang, codec }));
}

/** 纯函数：是否含音轨（Whisper 前置条件） */
function hasAudioStream(text) {
  return parseStreams(text).some((s) => s.type === 'Audio');
}

/** 纯函数：提取内嵌字幕为 SRT 的参数。streamIndex 是容器流序号（`Stream #0:2` 里的 2），不是字幕序号 */
function buildExtractArgs({ input, streamIndex, output }) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', input,
    '-map', `0:${streamIndex}`,
    '-c:s', 'srt',
    output,
  ];
}

function findSidecar(videoPath) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
  } catch {
    return null;
  }
  for (const name of matchSidecarNames(names, base)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).size > 0) return { path: full, name };
  }
  return null;
}

async function probeSubtitleStreams(inputPath, ffmpegPath) {
  const res = await run(ffmpegPath, ['-hide_banner', '-i', inputPath]);
  const text = (res.stdout || '') + (res.stderr || '');
  return { streams: parseSubtitleStreams(text), hasAudio: hasAudioStream(text), raw: text };
}

async function extractEmbedded({ ffmpegPath, input, streamIndex, output }) {
  const res = await run(ffmpegPath, buildExtractArgs({ input, streamIndex, output }));
  if (!res.ok) {
    throw new Error('提取内嵌字幕失败：' + ((res.stderr || '').trim().slice(-300) || 'FFmpeg 退出码 ' + res.code));
  }
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new Error('提取到的字幕为空，该字幕流可能不受支持。');
  }
  return { path: output, bytes: fs.statSync(output).size };
}

module.exports = { parseStreams, matchSidecarNames, parseSubtitleStreams, hasAudioStream, buildExtractArgs, findSidecar, probeSubtitleStreams, extractEmbedded };
