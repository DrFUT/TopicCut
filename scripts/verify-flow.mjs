// 场景验证：字幕来源生命周期（demo 泄漏 / 内嵌来源 / 无字幕入口 / 同目录来源）
// 用法：npm run verify:flow   （会先 vite build，再以 demo + scenario 模式启动 Electron）
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ffmpeg = require('../electron/services/ffmpeg.cjs');

const root = process.cwd();
const work = path.join(root, '.selfcheck');
const sidecarDir = path.join(work, 'sidecar');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400)))));
  });
}

console.log('--- 0. 准备场景素材');
fs.mkdirSync(sidecarDir, { recursive: true });
const status = await ffmpeg.detect(process.env.FFMPEG_PATH);
if (!status.found) {
  console.error('FAIL 未检测到 FFmpeg，无法生成场景素材（内嵌字幕流需要真实封装）。');
  process.exit(1);
}
const BIN = status.path;
const demoSrt = path.join(root, 'samples', 'demo.srt');

await run([BIN, '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-i', demoSrt,
  '-map', '0:v', '-map', '1:a', '-map', '2:s',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
  path.join(work, 'topiccut-embedded.mkv')]);

await run([BIN, '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
  path.join(work, 'topiccut-nosub.mp4')]);

await run([BIN, '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=20',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest',
  path.join(sidecarDir, 'movie.mp4')]);
fs.copyFileSync(demoSrt, path.join(sidecarDir, 'movie.srt'));
console.log('PASS 三个场景素材已生成（内嵌字幕 / 有音轨无字幕 / 同目录外挂字幕）');

console.log('\n--- 1. 以 demo + 场景模式启动 Electron');
const electronBin = require('electron');
const child = spawnSync(
  electronBin,
  ['.'],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TOPICCUT_DEMO: '1', TOPICCUT_SCENARIO: '1' },
  },
);

const out = ((child.stdout || '') + (child.stderr || ''))
  .split('\n')
  .filter((l) => /FLOW_|FLOW_SUMMARY/.test(l))
  .join('\n');
console.log(out || '(Electron 没有输出任何 FLOW 行)');

const reportPath = path.join(work, 'flow.json');
if (!fs.existsSync(reportPath)) {
  console.error('FAIL 没有生成 .selfcheck/flow.json，场景未跑完');
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
console.log(`\n截图：${path.join(work, 'flow.png')}`);
console.log(`结果：${report.passed} 通过 / ${report.failed} 失败`);
process.exit(report.failed === 0 && child.status === 0 ? 0 : 1);
