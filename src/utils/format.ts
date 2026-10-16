import type { SubtitleOrigin } from '../types/index.ts';

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatSeconds(totalSeconds: number): string {
  return `${totalSeconds.toFixed(1)} 秒`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fileSafeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clip';
}

/** AI 字幕写成 <视频名>.generated.srt；再导入同一视频时它虽在同目录，来源仍应如实标成 AI 生成 */
export function sidecarOrigin(name: string): SubtitleOrigin {
  return /\.generated\.srt$/i.test(name) ? 'ai' : 'sidecar';
}

/** 字幕来源的人话描述：不只给文件名，还要说清它从哪来 */
export function subtitleSourceText(origin: SubtitleOrigin, name: string, streamIndex?: number): string {
  switch (origin) {
    case 'sidecar':
      return `外挂字幕 · ${name}`;
    case 'embedded':
      return `内嵌字幕 · Embedded Subtitle Stream 0:${streamIndex ?? '?'}`;
    case 'ai':
      return `AI 生成 · ${name}`;
    default:
      return `手动导入 · ${name}`;
  }
}
