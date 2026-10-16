// 真实验证：字幕自动探测 / 内嵌字幕提取 / Whisper 进程控制（进度 + 取消）
// 用法：npm run verify:subtitles
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const ffmpeg = require('../electron/services/ffmpeg.cjs');
const subtitles = require('../electron/services/subtitles.cjs');
const whisper = require('../electron/services/whisper.cjs');
const { parseSrt } = await import('../src/utils/srt.ts');

const root = path.join(process.cwd());
const work = path.join(root, '.selfcheck');
fs.mkdirSync(work, { recursive: true });

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} → ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
};
const info = (label, value) => console.log(`     ${label} ${JSON.stringify(value)}`);

function ff(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400)))));
  });
}

console.log('--- 1. 检测 FFmpeg');
const ffRes = await ffmpeg.detect(process.env.FFMPEG_PATH);
if (!ffRes.found) {
  console.error('FAIL 未检测到 FFmpeg，无法验证。');
  process.exit(1);
}
check('FFmpeg 就绪', ffRes.found, true);
info('可执行文件', ffRes.path);

const BIN = ffRes.path;
const demoSrt = path.join(root, 'samples', 'demo.srt');

console.log('\n--- 2. 生成测试素材（真实视频/字幕）');
const embedded = path.join(work, 'topiccut-embedded.mkv');
const silent = path.join(work, 'topiccut-silent.mp4');
const sidecarDir = path.join(work, 'sidecar');
const sidecarVideo = path.join(sidecarDir, 'movie.mp4');
fs.mkdirSync(sidecarDir, { recursive: true });
fs.copyFileSync(demoSrt, path.join(sidecarDir, 'movie.srt'));

await ff([BIN, '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=60',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
  '-i', demoSrt,
  '-map', '0:v', '-map', '1:a', '-map', '2:s',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
  embedded]);
await ff([BIN, '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=5',
  '-an', silent]);
await ff([BIN, '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', sidecarVideo]);
info('内嵌字幕视频', embedded);
info('无音轨视频', silent);
info('同目录字幕视频', sidecarVideo);

console.log('\n--- 3. 同目录字幕检测');
const sidecar = subtitles.findSidecar(sidecarVideo);
check('找到同名 .srt', sidecar && sidecar.name, 'movie.srt');
check('不存在字幕时返回 null', subtitles.findSidecar(embedded), null);

console.log('\n--- 4. 内嵌字幕流检测');
const withSubs = await subtitles.probeSubtitleStreams(embedded, BIN);
check('内嵌字幕条数', withSubs.streams.length, 1);
info('字幕流', withSubs.streams);
check('有音轨', withSubs.hasAudio, true);
const silentProbe = await subtitles.probeSubtitleStreams(silent, BIN);
check('无音轨视频 hasAudio', silentProbe.hasAudio, false);
check('无字幕流', silentProbe.streams.length, 0);

console.log('\n--- 5. 提取内嵌字幕并回读');
const outSrt = path.join(work, 'extracted.srt');
await subtitles.extractEmbedded({ ffmpegPath: BIN, input: embedded, streamIndex: withSubs.streams[0].index, output: outSrt });
const extracted = parseSrt(fs.readFileSync(outSrt, 'utf8'));
check('提取后字幕条数', extracted.cues.length, 15);
check('首条起点（秒）', Math.round(extracted.cues[0].start), 80);
info('首条文本', extracted.cues[0].text);

console.log('\n--- 6. 无音轨视频应被 Whisper 前置检查拦下');
let noAudioError = '';
try {
  await whisper.transcribe({
    taskId: 1, whisperPath: BIN, modelPath: BIN, ffmpegPath: BIN,
    input: silent, outputSrt: path.join(work, 'never.srt'),
    workDir: path.join(work, 'whisper-work'), language: 'auto', threads: 2, durationSec: null,
    onProgress: () => {},
  });
} catch (err) {
  noAudioError = String(err.message);
}
check('提示无音轨', noAudioError.includes('没有音轨'), true);
info('错误文案', noAudioError);

console.log('\n--- 7. 转写进程控制（桩程序，仅验证进程/进度/取消，不含真实 ASR）');
const stub = path.join(work, 'whisper-stub.mjs');
fs.writeFileSync(
  stub,
  `import fs from 'node:fs';
const args = process.argv.slice(2);
const of = args[args.indexOf('-of') + 1];
const total = 100;
let i = 0;
const timer = setInterval(() => {
  i += 10;
  process.stderr.write('  progress = ' + (i * 3).toFixed(2) + ' / 300.00 secs ( 2.00 x)\\n');
  if (i >= total) {
    clearInterval(timer);
    fs.writeFileSync(of + '-audio.srt', '1\\n00:00:01,000 --> 00:00:05,000\\n你好，欢迎观看这个视频\\n\\n');
    process.exit(0);
  }
}, 120);
`,
  'utf8',
);

const ticks = [];
await whisper.runWhisper({
  taskId: 2,
  bin: process.execPath,
  args: [stub, '-m', 'ggml-base.bin', '-f', 'audio.wav', '-of', path.join(work, 'stub-out'), '-osrt'],
  durationSec: 0,
  onTick: (ratio, eta) => ticks.push({ percent: Math.round(ratio * 100), eta }),
});
check('进度回调次数', ticks.length >= 8, true);
check('进度单调递增', ticks.every((t, i) => i === 0 || t.percent >= ticks[i - 1].percent), true);
info('最后一次进度', ticks[ticks.length - 1]);
check('桩程序产出 SRT', fs.existsSync(path.join(work, 'stub-out-audio.srt')), true);

let cancelError = '';
const cancelTask = 3;
const running = whisper
  .runWhisper({
    taskId: cancelTask,
    bin: process.execPath,
    args: [stub, '-m', 'ggml-base.bin', '-f', 'audio.wav', '-of', path.join(work, 'stub-cancel'), '-osrt'],
    durationSec: 0,
    onTick: () => {},
  })
  .catch((err) => {
    cancelError = String(err.message);
  });
await new Promise((r) => setTimeout(r, 400));
check('取消信号已送达', whisper.cancel(cancelTask), true);
await running;
check('取消后以「已取消」结束', cancelError, '已取消。');

console.log('\n--- 8. Whisper 缺失时的错误文案');
let missingError = '';
try {
  await whisper.transcribe({
    taskId: 4, whisperPath: path.join(work, 'no-such-whisper.exe'), modelPath: BIN, ffmpegPath: BIN,
    input: embedded, outputSrt: path.join(work, 'never2.srt'),
    workDir: path.join(work, 'whisper-work2'), language: 'auto', threads: 2, durationSec: null,
    onProgress: () => {},
  });
} catch (err) {
  missingError = String(err.message);
}
check('未安装 whisper-cli 的提示', missingError.includes('whisper-cli'), true);

fs.rmSync(stub, { force: true });
fs.rmSync(path.join(work, 'stub-out-audio.srt'), { force: true });
fs.rmSync(path.join(os.tmpdir(), 'topiccut-unused'), { recursive: true, force: true });

console.log(failures === 0 ? '\n字幕链路与转写进程控制验证通过' : `\n${failures} 条断言失败`);
process.exit(failures === 0 ? 0 : 1);
