import { useState } from 'react';
import { formatClock } from '../utils/format.ts';
import type { AiVideoInsight } from '../types/index.ts';

export interface AskResult {
  question: string;
  answer: string;
  keywords: string[];
  clips: number;
}

interface Props {
  aiReady: boolean;
  hasSubtitle: boolean;
  cueCount: number;
  insight: AiVideoInsight | null;
  /** 最近一次分析失败但仍有上一次成功结果时，界面必须说清这是旧结论 */
  insightStale: boolean;
  analyzing: boolean;
  progress: { percent: number; stage: string } | null;
  asking: boolean;
  askResult: AskResult | null;
  onAnalyze: () => void;
  onCancel: () => void;
  onAsk: (question: string) => void;
  onUseKeyword: (term: string) => void;
  onOpenSettings: () => void;
  onSeekChapter: (start: number) => void;
}

function Chip({ text, onClick }: { text: string; onClick?: () => void }) {
  const cls =
    'rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-slate-300 ' +
    (onClick ? 'cursor-pointer transition hover:border-amber-200/40 hover:text-amber-50' : '');
  return onClick ? (
    <button className={cls} onClick={onClick} title="用这个词检索字幕">
      {text}
    </button>
  ) : (
    <span className={cls}>{text}</span>
  );
}

/**
 * AI Insight：全片结论 + Ask AI。
 * 刻意做成"结论卡"而不是聊天窗——每个结论都能回到真实字幕与真实时间点。
 */
export default function InsightPanel({
  aiReady,
  hasSubtitle,
  cueCount,
  insight,
  insightStale,
  analyzing,
  progress,
  asking,
  askResult,
  onAnalyze,
  onCancel,
  onAsk,
  onUseKeyword,
  onOpenSettings,
  onSeekChapter,
}: Props) {
  const [question, setQuestion] = useState('');

  const ask = () => {
    const q = question.trim();
    if (!q) return;
    onAsk(q);
  };

  return (
    <section className="panel mt-8 px-6 py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="label">AI Insight</h2>
        <div className="flex items-center gap-2">
          <button className="btn px-4 py-1.5 text-[12px]" disabled={!aiReady || !hasSubtitle || analyzing} onClick={onAnalyze}>
            {analyzing ? '分析中…' : '分析全片'}
          </button>
          {!aiReady && (
            <button className="btn px-4 py-1.5 text-[12px]" onClick={onOpenSettings}>
              配置 AI
            </button>
          )}
        </div>
      </div>

      {!aiReady ? (
        <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
          AI 理解能力未启用：在「设置 · AI Provider」填写 endpoint / model / API Key 后即可使用全片分析、片段分析与 Ask AI。
          不配置不影响字幕检索、预览与导出。
        </p>
      ) : !hasSubtitle ? (
        <p className="mt-3 text-[12px] leading-relaxed text-slate-500">
          AI 分析的依据是字幕文本。先在左侧导入字幕，或用本地 Whisper 生成字幕。
        </p>
      ) : null}

      {analyzing && progress && (
        <div className="mt-4 space-y-2">
          <p className="text-[12px] text-slate-300">{progress.stage}…</p>
          <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-slate-200/70 transition-all" style={{ width: `${progress.percent}%` }} />
          </div>
          <button className="btn px-4 py-1.5 text-[12px]" onClick={onCancel}>
            取消
          </button>
        </div>
      )}

      {insight && !analyzing && (
        <div className="mt-5 space-y-5">
          <div>
            <div className="label mb-2">视频摘要 · {cueCount} 条字幕 / {insight.chunks} 段</div>
            {insightStale && (
              <p className="mb-2 text-[11px] leading-relaxed text-amber-200/80">
                最近一次分析没有成功，下面是上一次成功时的结论，可能与当前字幕不一致。
              </p>
            )}
            <p className="text-[13px] leading-relaxed text-slate-300">{insight.summary}</p>
            {insight.coarsened && (
              <p className="mt-1.5 text-[10px] text-slate-600">字幕较长，已按更少的大块分析，章节粒度相应变粗。</p>
            )}
          </div>

          {insight.themes.length > 0 && (
            <div>
              <div className="label mb-2">主要主题</div>
              <div className="flex flex-wrap gap-2">
                {insight.themes.map((t) => (
                  <Chip key={t} text={t} onClick={() => onUseKeyword(t)} />
                ))}
              </div>
            </div>
          )}

          {insight.keywords.length > 0 && (
            <div>
              <div className="label mb-2">关键词</div>
              <div className="flex flex-wrap gap-2">
                {insight.keywords.map((t) => (
                  <Chip key={t} text={t} onClick={() => onUseKeyword(t)} />
                ))}
              </div>
            </div>
          )}

          {insight.chapters.length > 0 && (
            <div>
              <div className="label mb-2">章节划分 · 时间取自字幕真实边界</div>
              <div className="space-y-2">
                {insight.chapters.map((c) => (
                  <button
                    key={`${c.start}-${c.end}`}
                    className="block w-full rounded-lg border border-white/[0.06] px-3 py-2 text-left transition hover:border-white/20"
                    onClick={() => onSeekChapter(c.start)}
                  >
                    <span className="text-[12px] tracking-wide text-slate-400">
                      {formatClock(c.start)} — {formatClock(c.end)}
                    </span>
                    <span className="ml-3 text-[13px] text-slate-100">{c.title}</span>
                    {c.summary && <p className="mt-1 text-[12px] leading-relaxed text-slate-500">{c.summary}</p>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {aiReady && hasSubtitle && (
        <div className="mt-6 border-t border-white/[0.06] pt-4">
          <div className="label mb-2">Ask AI · 回答只依据本视频字幕</div>
          <div className="flex items-center gap-3">
            <input
              className="field h-10 flex-1"
              placeholder="关于这个视频的一个问题"
              value={question}
              disabled={asking}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
            />
            <button className="btn h-10 px-5 whitespace-nowrap" disabled={asking || !question.trim()} onClick={ask}>
              {asking ? '查找中…' : '提问'}
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            问题先转成检索关键词，再由 TopicCut 在真实字幕里定位片段；时间点不来自模型生成。
          </p>

          {askResult && (
            <div className="mt-3 space-y-2 rounded-lg border border-white/[0.06] px-4 py-3">
              <p className="text-[12px] text-slate-400">问：{askResult.question}</p>
              <div className="label mt-2">AI 回答 · 只依据下面这些本地检索到的字幕</div>
              <p className="text-[13px] leading-relaxed text-slate-200">{askResult.answer}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="label">检索词</span>
                {askResult.keywords.map((k) => (
                  <Chip key={k} text={k} onClick={() => onUseKeyword(k)} />
                ))}
                <span className="text-[11px] text-slate-500">
                  · 已在字幕中定位 {askResult.clips} 个片段{askResult.clips ? '（见下方列表）' : '，没有可展示的片段'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
