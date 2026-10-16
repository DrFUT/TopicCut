import { useState } from 'react';
import type { RefObject } from 'react';
import { formatClock } from '../utils/format.ts';
import type { SubtitleCue, VideoSource } from '../types/index.ts';

interface Props {
  video: VideoSource | null;
  clip: { start: number; end: number } | null;
  cues: SubtitleCue[];
  videoRef: RefObject<HTMLVideoElement>;
}

export default function PlayerPane({ video, clip, cues, videoRef }: Props) {
  const [current, setCurrent] = useState(0);
  const cue = cues.find((c) => current >= c.start && current <= c.end);

  return (
    <section className="flex h-full flex-col gap-4">
      <div className="relative flex-1 overflow-hidden rounded-xl border border-white/[0.07] bg-black">
        {video ? (
          <video
            ref={videoRef}
            src={video.mediaUrl}
            className="h-full w-full object-contain"
            controls
            playsInline
            onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-10 text-center">
            <p className="max-w-[240px] text-[13px] leading-relaxed tracking-wide text-slate-600">
              导入视频后可在此预览选中的片段
            </p>
          </div>
        )}

        {clip && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center pt-3">
            <span className="rounded-full border border-white/10 bg-black/60 px-4 py-1 text-[11px] tracking-[0.14em] text-slate-300">
              片段 {formatClock(clip.start)} — {formatClock(clip.end)}
            </span>
          </div>
        )}
      </div>

      <div className="min-h-[68px] space-y-1.5 px-1">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.24em] text-slate-600">
          <span>当前位置</span>
          <span>{formatClock(current)}</span>
        </div>
        <p className="text-[14px] leading-relaxed text-slate-300">
          {cue ? cue.text : <span className="text-slate-700">无字幕</span>}
        </p>
      </div>
    </section>
  );
}
