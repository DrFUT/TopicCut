import type { ReactNode } from 'react';
import { formatClock } from '../utils/format.ts';
import type { AiClipInsight, CandidateClip } from '../types/index.ts';

interface Props {
  clip: CandidateClip;
  order: number;
  active: boolean;
  exporting: boolean;
  progress: number | null;
  canExport: boolean;
  aiReady: boolean;
  analyzing: boolean;
  insight: AiClipInsight | null;
  onSelect: () => void;
  onExport: () => void;
  onAnalyze: () => void;
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    let i = lower.indexOf(needle);
    while (i !== -1) {
      ranges.push([i, i + needle.length]);
      i = lower.indexOf(needle, i + needle.length);
    }
  }
  if (ranges.length === 0) return <>{text}</>;

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r] as [number, number]);
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([from, to], i) => {
    if (from > cursor) nodes.push(<span key={`n${i}`}>{text.slice(cursor, from)}</span>);
    nodes.push(
      <mark key={`m${i}`} className="rounded bg-amber-100/[0.15] px-0.5 text-amber-50">
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  });
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);

  return <>{nodes}</>;
}

export default function ClipCard({
  clip,
  order,
  active,
  exporting,
  progress,
  canExport,
  aiReady,
  analyzing,
  insight,
  onSelect,
  onExport,
  onAnalyze,
}: Props) {
  const duration = clip.end - clip.start;

  return (
    <article className={`clip-card ${active ? 'is-active' : ''}`}>
      <div className="flex items-start justify-between gap-6">
        <button className="flex-1 text-left" onClick={onSelect}>
          <div className="flex items-baseline gap-3">
            <span className="text-[11px] tracking-[0.2em] text-slate-600">
              {String(order).padStart(2, '0')}
            </span>
            <span className="text-[19px] font-light tracking-[0.06em] text-slate-100">
              {formatClock(clip.start)} <span className="text-slate-700">—</span> {formatClock(clip.end)}
            </span>
            <span className="text-[11px] text-slate-600">{duration.toFixed(0)} 秒</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="label">关键词</span>
            {clip.terms.map((t) => (
              <span key={t} className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-slate-300">
                {t}
              </span>
            ))}
          </div>

          <div className="mt-3.5 space-y-1.5 border-l border-white/10 pl-4">
            <div className="label mb-2">字幕证据 · 原文</div>
            {clip.matched.slice(0, 4).map((cue) => (
              <p key={cue.seq} className="text-[13px] leading-relaxed text-slate-400">
                <span className="mr-2 text-[11px] text-slate-600">{formatClock(cue.start)}</span>
                <Highlighted text={cue.text} terms={clip.terms} />
                {cue.text.length > 60 && <span className="text-slate-600">…</span>}
              </p>
            ))}
            {clip.matched.length > 4 && (
              <p className="text-[11px] text-slate-600">还有 {clip.matched.length - 4} 条命中字幕</p>
            )}
          </div>
        </button>

        <div className="flex w-32 shrink-0 flex-col items-end gap-2">
          <button className="btn px-5 py-2" disabled={!canExport || exporting} onClick={onExport}>
            {exporting ? '导出中' : '导出'}
          </button>
          <button
            className="btn px-5 py-2 text-[12px]"
            disabled={!aiReady || analyzing}
            onClick={onAnalyze}
            title={aiReady ? '让 AI 读这段字幕，给出总结与用途建议' : '未配置 AI Provider'}
          >
            {analyzing ? '分析中…' : 'AI 分析'}
          </button>
          {progress !== null && (
            <div className="h-0.5 w-24 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-amber-100/70 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          <span className="text-right text-[10px] leading-relaxed text-slate-600">
            {active ? '预览已定位' : canExport ? '' : '需要视频与 FFmpeg'}
          </span>
        </div>
      </div>

      {insight && (
        <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
          <div>
            <div className="label mb-1.5">内容总结 · AI 概括</div>
            <p className="text-[13px] leading-relaxed text-slate-300">{insight.summary}</p>
          </div>
          {insight.points.length > 0 && (
            <div>
              <div className="label mb-1.5">核心观点</div>
              <ul className="space-y-1">
                {insight.points.map((p, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-slate-400">
                    · {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {insight.useCases.length > 0 && (
            <div>
              <div className="label mb-1.5">推荐用途 · AI 推断</div>
              <div className="flex flex-wrap gap-2">
                {insight.useCases.map((u) => (
                  <span key={u} className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-slate-300">
                    {u}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="text-[10px] text-slate-600">以上结论由 AI 依据本片段字幕生成，时间点仍以左侧字幕证据为准。</p>
        </div>
      )}
    </article>
  );
}
