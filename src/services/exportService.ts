import { requireBridge } from './bridge.ts';
import { fileSafeName, formatClock } from '../utils/format.ts';
import type { CandidateClip, ExportResult, VideoSource } from '../types/index.ts';

export function suggestFileName(video: VideoSource, clip: CandidateClip): string {
  const topic = clip.terms[0] || 'topic';
  const base = video.name.replace(/\.[^.]+$/, '');
  return `${base}-${fileSafeName(topic)}-${formatClock(clip.start).replace(/:/g, 'm')}-${formatClock(clip.end).replace(/:/g, 'm')}.mp4`;
}

/**
 * 纯函数：把片段末尾截到视频真实长度内。
 * AI 生成的字幕最后几段常带 whisper.cpp 的 30 秒窗口补白（时间戳能超出片尾几秒），
 * 不截就会导出一个比预期短、却和界面显示不一致的片段。
 */
export function clampClipRange(video: VideoSource, clip: CandidateClip): { start: number; end: number } {
  const duration = video.probe?.duration ?? 0;
  const end = duration > clip.start ? Math.min(clip.end, duration) : clip.end;
  return { start: clip.start, end };
}

export async function exportClip(video: VideoSource, clip: CandidateClip): Promise<ExportResult> {
  const bridge = requireBridge();
  const range = clampClipRange(video, clip);
  return bridge.exportClip({
    input: video.path,
    start: range.start,
    end: range.end,
    suggestedName: suggestFileName(video, clip),
  });
}

export function onExportProgress(handler: (p: { start: number; end: number; percent: number }) => void): () => void {
  const bridge = requireBridge();
  return bridge.onExportProgress(handler);
}
