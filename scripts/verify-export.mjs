/**
 * 真实导出验证：用与桌面端完全相同的 ffmpeg 服务代码，
 * 生成测试视频 → 解析样例字幕 → 导出候选片段 → 校验输出时长。
 *
 *   node scripts/verify-export.mjs [视频路径]
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ffmpeg = require('../electron/services/ffmpeg.cjs');
const { parseSrt } = await import('../src/utils/srt.ts');
const { buildClips } = await import('../src/utils/clips.ts');

const OUT_DIR = join(process.cwd(), '.selfcheck');
const query = process.env.TOPICCUT_VERIFY_QUERY || '人工智能';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`);
}

mkdirSync(OUT_DIR, { recursive: true });

console.log('--- 1. 检测 FFmpeg');
const status = await ffmpeg.detect(process.env.FFMPEG_PATH);
if (!status.found) {
  console.log('FAIL 未检测到可运行的 FFmpeg。安装其一后重试：');
  console.log('  winget install Gyan.FFmpeg      （系统级）');
  console.log('  npm i -D ffmpeg-static          （仅本机开发验证）');
  process.exit(1);
}
console.log(`PASS FFmpeg 就绪 → ${status.path}`);
console.log(`     ${status.version}`);

console.log('\n--- 2. 准备测试视频');
let video = process.argv[2];
if (!video) {
  video = join(OUT_DIR, 'topiccut-source.mp4');
  if (!existsSync(video)) {
    console.log('生成 13 分钟测试视频（testsrc2 + 音频，1 秒一个关键帧）...');
    const gen = spawnSync(
      status.path,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=10:duration=780',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=780',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10',
        '-c:a', 'aac', '-shortest',
        video,
      ],
      { windowsHide: true, timeout: 300000 },
    );
    if (gen.status !== 0) {
      console.log('FAIL 生成测试视频失败：', String(gen.stderr || gen.error || '').slice(0, 300));
      process.exit(1);
    }
  }
}
if (!existsSync(video)) {
  console.log('FAIL 视频文件不存在：', video);
  process.exit(1);
}
const sourceInfo = await ffmpeg.probe(video, status.path);
console.log(`PASS 源视频 ${video}`);
console.log(`     时长 ${sourceInfo?.duration}s · ${sourceInfo?.width}×${sourceInfo?.height} · ${(statSync(video).size / 1024 / 1024).toFixed(1)} MB`);

console.log('\n--- 3. 解析字幕并生成候选片段');
const { cues } = parseSrt(readFileSync(join(process.cwd(), 'samples', 'demo.srt'), 'utf8'));
check('字幕条数', cues.length, 15);
const clips = buildClips(cues, query);
check('候选片段数', clips.length, 4);
const clip = clips[0];
console.log(`     导出目标：${clip.start}s → ${clip.end}s（${(clip.end - clip.start).toFixed(1)} 秒）`);

console.log('\n--- 4. 调用 FFmpeg 导出');
const output = join(OUT_DIR, `export-${Math.round(clip.start)}s.mp4`);
let lastPercent = -1;
const result = await ffmpeg.exportClip({
  ffmpegPath: status.path,
  input: video,
  output,
  start: clip.start,
  end: clip.end,
  onProgress: (p) => {
    const pct = Math.round(p * 100);
    if (pct !== lastPercent) {
      lastPercent = pct;
      process.stdout.write(`\r     进度 ${String(pct).padStart(3)}%`);
    }
  },
});
process.stdout.write('\n');
check('输出文件存在', existsSync(output), true);
console.log(`     输出 ${output} (${(result.size / 1024 / 1024).toFixed(2)} MB)`);

const outInfo = await ffmpeg.probe(output, status.path);
const expected = clip.end - clip.start;
const drift = Math.abs((outInfo?.duration ?? 0) - expected);
console.log(`     导出时长 ${outInfo?.duration}s，期望 ${expected.toFixed(1)}s，偏差 ${drift.toFixed(2)}s`);
check('时长偏差 < 1.5 秒', drift < 1.5, true);
check('输出短于源视频', (outInfo?.duration ?? 1e9) < (sourceInfo?.duration ?? 0), true);

console.log(failures === 0 ? '\n导出闭环验证通过' : `\n${failures} 项验证失败`);
process.exit(failures === 0 ? 0 : 1);
