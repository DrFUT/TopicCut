import type { SubtitleCue } from '../types/index.ts';

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

export function timeToSeconds(raw: string): number | null {
  const m = TIME_RE.exec(raw.trim());
  if (!m) return null;
  const [, h, min, sec, ms] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(sec) + Number(ms.padEnd(3, '0')) / 1000;
}

/** 解析 SRT 文本为字幕数组，时间单位为秒 */
export function parseSrt(text: string): { cues: SubtitleCue[]; skipped: number } {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');
  const cues: SubtitleCue[] = [];
  let skipped = 0;

  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) {
      if (lines.length > 0) skipped += 1;
      continue;
    }

    const [rawStart, rawEnd] = lines[timeLineIndex].split('-->');
    const start = timeToSeconds(rawStart || '');
    const end = timeToSeconds((rawEnd || '').trim().split(/\s+/)[0]);
    const content = lines
      .slice(timeLineIndex + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .trim();

    if (start === null || end === null || end <= start || !content) {
      skipped += 1;
      continue;
    }

    cues.push({ seq: 0, start, end, text: content });
  }

  return {
    cues: cues
      .sort((a, b) => a.start - b.start || b.end - a.end)
      .map((c, i) => ({ ...c, seq: i + 1, start: Number(c.start.toFixed(3)), end: Number(c.end.toFixed(3)) })),
    skipped,
  };
}
