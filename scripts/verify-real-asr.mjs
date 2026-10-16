// 真实 whisper.cpp 端到端验证：视频 → 本地转写 → 自动生成 SRT → 主题检索 → 预览 → FFmpeg 导出
// 用法：node scripts/verify-real-asr.mjs [视频路径]   （默认用 .selfcheck/realtest 下的真实切片）
// 前置：本机已解压 whisper.cpp 预编译包，且 ggml-*.bin 在 ~/.cache/whisper.cpp（否则脚本会给出可读提示并退出）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const whisper = require('../electron/services/whisper.cjs');
const ffmpeg = require('../electron/services/ffmpeg.cjs');

const root = process.cwd();
const work = path.join(root, '.selfcheck');
const modelSize = process.env.TOPICCUT_REAL_ASR_MODEL || 'small';
const language = process.env.TOPICCUT_REAL_ASR_LANG || 'zh';

const videoArg = process.argv[2];
const defaultClip = path.join(work, 'realtest', '魔方小姐', "魔方小姐.It's.My.Time.sample.mp4");
const video = videoArg ? path.resolve(videoArg) : defaultClip;

function die(msg) {
  console.error('FAIL ' + msg);
  process.exit(1);
}

console.log('--- 0. 环境与素材');
if (!fs.existsSync(video)) die(`找不到待测视频：${video}\n     先切一段真实视频放到 .selfcheck/realtest/，或把路径作为参数传进来。`);
const stat = fs.statSync(video);
console.log(`视频 ${path.basename(video)} · ${(stat.size / 1048576).toFixed(1)} MB`);

const ff = await ffmpeg.detect(process.env.FFMPEG_PATH);
if (!ff.found) die('未检测到 FFmpeg，无法抽音轨/导出。');
console.log(`FFmpeg ${ff.path}`);

const cli = await whisper.detect(process.env.WHISPER_PATH);
if (!cli.found) die('未检测到 whisper-cli。解压 whisper.cpp releases 的 whisper-bin-x64.zip 后重试。');
console.log(`whisper-cli ${cli.path}\n     ${cli.version || '（版本行未给出）'}`);

const model = whisper.detectModel({ whisperPath: cli.path, size: modelSize });
if (!model.found) {
  die(`未找到 ggml-${modelSize}.bin。放一份到 ${path.join(os.homedir(), '.cache', 'whisper.cpp')}，或设 TOPICCUT_REAL_ASR_MODEL=tiny|base|small|medium。`);
}
console.log(`模型 ggml-${modelSize}.bin · ${(model.bytes / 1048576).toFixed(0)} MB · ${model.path}`);

const generated = path.join(path.dirname(video), path.basename(video, path.extname(video)) + '.generated.srt');
if (fs.existsSync(generated)) {
  fs.rmSync(generated);
  console.log('已删除旧的 .generated.srt，确保本次是真实生成');
}

console.log('\n--- 1. 以场景模式启动 Electron（真实转写会跑几分钟）');
const electronBin = require('electron');
const child = spawn(electronBin, ['.'], {
  cwd: root,
  env: {
    ...process.env,
    TOPICCUT_DEMO: '1',
    TOPICCUT_SCENARIO: '1',
    TOPICCUT_REAL_ASR: video,
    TOPICCUT_REAL_ASR_MODEL: modelSize,
    TOPICCUT_REAL_ASR_LANG: language,
  },
  windowsHide: true,
});

const exitCode = await new Promise((resolve) => {
  const handle = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (/FLOW_/.test(line)) console.log(line);
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('close', resolve);
});

const reportPath = path.join(work, 'flow.json');
const asrPath = path.join(work, 'realasr.json');
if (!fs.existsSync(reportPath)) die('场景没有跑完（缺少 .selfcheck/flow.json）');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log('\n--- 2. 真实 ASR 结果');
if (fs.existsSync(asrPath)) console.log(fs.readFileSync(asrPath, 'utf8'));
const exports = path.join(work, 'realtest');
if (fs.existsSync(exports)) {
  for (const f of fs.readdirSync(exports)) {
    if (f.startsWith('export-') && f.endsWith('.mp4')) {
      console.log(`导出产物 ${f} · ${(fs.statSync(path.join(exports, f)).size / 1048576).toFixed(2)} MB`);
    }
  }
}

console.log(`\n结果：${report.passed} 通过 / ${report.failed} 失败（截图 .selfcheck/realasr.png）`);
process.exit(report.failed === 0 && exitCode === 0 ? 0 : 1);
