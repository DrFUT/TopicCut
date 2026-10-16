import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = [
  'C:\\ffmpeg',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\tools',
  'C:\\ProgramData\\chocolatey\\bin',
  join(process.env.LOCALAPPDATA || '', 'Programs'),
  join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages'),
  join(process.env.USERPROFILE || '', 'scoop/apps/ffmpeg'),
  join(process.env.USERPROFILE || '', '.cargo/bin'),
  'D:\\ffmpeg',
];

const found = [];
function probe(p) {
  if (!existsSync(p)) return;
  try {
    const entries = readdirSync(p);
    for (const e of entries) {
      if (!/ffmpeg(\.exe)?$/i.test(e)) continue;
      const full = join(p, e);
      try {
        if (statSync(full).isFile()) found.push(full);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

for (const root of roots) {
  probe(root);
  // 常见子目录 bin
  probe(join(root, 'bin'));
}
// 递归一层 Packages 目录
for (const root of [join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages')]) {
  if (!existsSync(root)) continue;
  for (const pkg of readdirSync(root)) {
    probe(join(root, pkg, 'bin'));
    probe(join(root, pkg));
  }
}

console.log('候选文件:', found.length ? found.join('\n  ') : '无');

for (const bin of [...new Set([...found, 'ffmpeg', 'ffmpeg.exe'])]) {
  const r = spawnSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).split('\n')[0] || (r.error ? r.error.code : 'no output');
  console.log(`  ${bin} → ${r.status === 0 ? 'OK' : 'FAIL'}: ${out.slice(0, 70)}`);
}
