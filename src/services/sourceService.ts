import { requireBridge } from './bridge.ts';
import { parseSrt } from '../utils/srt.ts';
import type { FfmpegStatus, ProbeInfo, SubtitleFile, SubtitleOrigin, SubtitleSource, VideoSource } from '../types/index.ts';

export async function pickVideo(): Promise<VideoSource | null> {
  const video = await requireBridge().pickVideo();
  if (!video) return null;
  if (!/\.(mp4|mkv|mov)$/i.test(video.name)) {
    throw new Error(`不支持的视频格式：${video.name}（当前支持 mp4 / mkv / mov）`);
  }
  return video;
}

export async function probeVideo(video: VideoSource): Promise<ProbeInfo | null> {
  if (video.probe && video.probe.duration) return video.probe;
  return requireBridge().probe(video.path);
}

export async function detectFfmpeg(): Promise<FfmpegStatus> {
  return requireBridge().detectFfmpeg();
}

export async function saveFfmpegPath(ffmpegPath: string): Promise<FfmpegStatus> {
  const bridge = requireBridge();
  await bridge.saveSettings({ ffmpegPath });
  return bridge.detectFfmpeg();
}

export function toSubtitleSource(file: SubtitleFile, origin: SubtitleOrigin = 'manual'): SubtitleSource {
  const { cues, skipped } = parseSrt(file.text);
  if (cues.length === 0) {
    throw new Error(`未能从 ${file.name} 解析出任何字幕条目，请检查 SRT 时间轴格式（00:01:20,000 --> 00:01:45,000）。`);
  }
  return { path: file.path, name: file.name, bytes: file.bytes, cues, skipped, origin };
}

export async function pickSubtitle(): Promise<SubtitleSource | null> {
  const file = await requireBridge().pickSubtitle();
  return file ? toSubtitleSource(file) : null;
}
