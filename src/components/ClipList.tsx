import ClipCard from './ClipCard.tsx';
import type { AiClipInsight, CandidateClip } from '../types/index.ts';

interface Props {
  clips: CandidateClip[];
  searched: boolean;
  activeId: string | null;
  exportingId: string | null;
  progress: number | null;
  canExport: boolean;
  aiReady: boolean;
  analyzingId: string | null;
  insights: Record<string, AiClipInsight>;
  onSelect: (clip: CandidateClip) => void;
  onExport: (clip: CandidateClip) => void;
  onAnalyze: (clip: CandidateClip) => void;
}

export default function ClipList({
  clips,
  searched,
  activeId,
  exportingId,
  progress,
  canExport,
  aiReady,
  analyzingId,
  insights,
  onSelect,
  onExport,
  onAnalyze,
}: Props) {
  if (clips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-10 text-center">
        <p className="max-w-[320px] text-[13px] leading-loose tracking-wide text-slate-600">
          {searched
            ? '字幕中没有匹配的关键词。换一个主题词，或尝试更短的词。'
            : '导入字幕并输入关键词，TopicCut 会把命中的字幕聚合成可审核的剪辑建议。'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-16">
      {clips.map((clip, i) => (
        <ClipCard
          key={clip.id}
          clip={clip}
          order={i + 1}
          active={clip.id === activeId}
          exporting={exportingId === clip.id}
          progress={exportingId === clip.id ? progress : null}
          canExport={canExport}
          aiReady={aiReady}
          analyzing={analyzingId === clip.id}
          insight={insights[clip.id] ?? null}
          onSelect={() => onSelect(clip)}
          onExport={() => onExport(clip)}
          onAnalyze={() => onAnalyze(clip)}
        />
      ))}
    </div>
  );
}
