import type { CandidateClip, SubtitleCue } from '../types/index.ts';

export interface ClipOptions {
  /** 两个匹配字幕之间小于该间隔就合并为同一片段 */
  mergeGapSeconds: number;
  /** 片段前后各多保留几条字幕作为上下文 */
  contextCues: number;
  minDuration: number;
  maxDuration: number;
}

export const DEFAULT_CLIP_OPTIONS: ClipOptions = {
  mergeGapSeconds: 10,
  contextCues: 1,
  minDuration: 8,
  maxDuration: 600,
};

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

export function extractTerms(query: string): string[] {
  return query
    .split(/[,，、;；|/]+|\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t, i, all) => all.findIndex((o) => normalizeText(o) === normalizeText(t)) === i);
}

export function matchedTerms(text: string, terms: string[]): string[] {
  const value = normalizeText(text);
  return terms.filter((t) => value.includes(normalizeText(t)));
}

/** 关键词命中的字幕条目 */
export function findMatchingCues(cues: SubtitleCue[], terms: string[]): SubtitleCue[] {
  if (terms.length === 0) return [];
  return cues.filter((c) => matchedTerms(c.text, terms).length > 0);
}

function scoreOf(matched: SubtitleCue[], terms: string[]): number {
  const termHits = new Set<string>();
  let hits = 0;
  for (const cue of matched) {
    hits += matchedTerms(cue.text, terms).length;
    for (const t of matchedTerms(cue.text, terms)) termHits.add(t);
  }
  const spread = matched.length > 0 ? matched[matched.length - 1].end - matched[0].start : 0;
  // 命中密度越高、覆盖关键词越多，得分越高
  return Number((hits * 10 + termHits.size * 6 - spread / 120).toFixed(2));
}

/** 由命中字幕生成候选片段：合并相邻命中、补充上下文、限制时长 */
export function buildClips(cues: SubtitleCue[], query: string, options: ClipOptions = DEFAULT_CLIP_OPTIONS): CandidateClip[] {
  const terms = extractTerms(query);
  if (terms.length === 0 || cues.length === 0) return [];

  const hitIndexes: number[] = [];
  cues.forEach((cue, i) => {
    if (matchedTerms(cue.text, terms).length > 0) hitIndexes.push(i);
  });
  if (hitIndexes.length === 0) return [];

  const groups: number[][] = [];
  let current: number[] = [hitIndexes[0]];
  for (let k = 1; k < hitIndexes.length; k += 1) {
    const prev = current[current.length - 1];
    const next = hitIndexes[k];
    const gap = cues[next].start - cues[prev].end;
    if (gap <= options.mergeGapSeconds) current.push(next);
    else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);

  const expanded = groups.map((group) => ({
    matchFrom: group[0],
    matchTo: group[group.length - 1],
    matched: group.map((i) => cues[i]),
  }));

  // 上下文扩展后再合并重叠片段：只在时间上真正紧邻时才扩展
  const raw = expanded.map((g) => {
    let from = g.matchFrom;
    let to = g.matchTo;
    for (let k = 0; k < options.contextCues; k += 1) {
      const prev = from - 1;
      if (prev >= 0 && cues[from].start - cues[prev].end <= options.mergeGapSeconds) from = prev;
      else break;
    }
    for (let k = 0; k < options.contextCues; k += 1) {
      const next = to + 1;
      if (next < cues.length && cues[next].start - cues[to].end <= options.mergeGapSeconds) to = next;
      else break;
    }
    return { start: cues[from].start, end: cues[to].end, from, to, matched: g.matched };
  });

  const merged: typeof raw = [];
  for (const item of raw) {
    const last = merged[merged.length - 1];
    if (last && item.start - last.end <= 0.5) {
      last.end = Math.max(last.end, item.end);
      last.to = Math.max(last.to, item.to);
      last.from = Math.min(last.from, item.from);
      last.matched = [...last.matched, ...item.matched];
    } else {
      merged.push({ ...item });
    }
  }

  const clips: CandidateClip[] = merged.map((item) => {
    let start = item.start;
    let end = item.end;
    if (end - start < options.minDuration) {
      const nextCue = cues[item.to + 1];
      end = nextCue && nextCue.end - start <= options.maxDuration ? nextCue.end : start + options.minDuration;
    }
    if (end - start > options.maxDuration) end = start + options.maxDuration;

    const cuesInRange = cues.filter((c) => c.end > start && c.start < end);
    const matched = item.matched.filter((c) => c.end > start && c.start < end);
    const foundTerms = new Set<string>();
    matched.forEach((c) => matchedTerms(c.text, terms).forEach((t) => foundTerms.add(t)));

    return {
      id: `clip-${Math.round(start * 100)}-${Math.round(end * 100)}`,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      terms: [...foundTerms],
      matched,
      cues: cuesInRange,
      score: scoreOf(matched, terms),
    };
  });

  return clips.sort((a, b) => b.score - a.score || a.start - b.start);
}
