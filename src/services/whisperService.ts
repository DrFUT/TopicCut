import { requireBridge } from './bridge.ts';
import { toSubtitleSource } from './sourceService.ts';
import type { SubtitleProbe, SubtitleSource, WhisperStatus } from '../types/index.ts';

export const MODEL_SIZES = ['tiny', 'base', 'small', 'medium'] as const;
export type ModelSize = (typeof MODEL_SIZES)[number];

export interface WhisperSettings {
  modelSize: ModelSize;
  language: string;
  threads: number;
}

export const DEFAULT_WHISPER_SETTINGS: WhisperSettings = { modelSize: 'base', language: 'auto', threads: 4 };

export async function probeSubtitles(videoPath: string): Promise<SubtitleProbe> {
  return requireBridge().probeSubtitles(videoPath);
}

export async function detectWhisper(): Promise<WhisperStatus> {
  return requireBridge().detectWhisper();
}

export async function pickWhisperBinary(): Promise<WhisperStatus> {
  return requireBridge().pickWhisperBinary();
}

export async function pickWhisperModel(): Promise<WhisperStatus> {
  return requireBridge().pickWhisperModel();
}

export async function loadWhisperSettings(): Promise<WhisperSettings> {
  const saved = (await requireBridge().getSettings()).whisper as Partial<WhisperSettings> | undefined;
  return { ...DEFAULT_WHISPER_SETTINGS, ...(saved || {}) };
}

export async function saveWhisperSettings(patch: Partial<WhisperSettings>): Promise<WhisperSettings> {
  const bridge = requireBridge();
  const current = (await bridge.getSettings()).whisper as Partial<WhisperSettings> | undefined;
  const next = { ...DEFAULT_WHISPER_SETTINGS, ...(current || {}), ...patch };
  await bridge.saveSettings({ whisper: next });
  return next;
}

/** 切换档位 = 放弃「手动指定的模型文件」，改回按 ggml-<size>.bin 自动查找，避免下拉框和实际模型不一致 */
export async function selectModelSize(size: ModelSize): Promise<WhisperSettings> {
  await requireBridge().saveSettings({ modelPath: null });
  return saveWhisperSettings({ modelSize: size });
}

/** 从视频里提取一条内嵌字幕轨并解析 */
export async function extractEmbedded(videoPath: string, streamIndex: number): Promise<SubtitleSource | null> {
  const res = await requireBridge().extractEmbedded({ videoPath, streamIndex });
  if (res.canceled) return null;
  if (!res.ok || !res.file) throw new Error(res.error || '提取内嵌字幕失败');
  return { ...toSubtitleSource(res.file, 'embedded'), streamIndex };
}

/** 视频 → 16kHz 音轨 → whisper-cli → <视频名>.generated.srt，全程本机 */
export async function transcribe(
  videoPath: string,
  taskId: number,
  onProgress: (percent: number, eta: number | null, stage: string) => void,
): Promise<{ subtitle: SubtitleSource; elapsedMs: number; path: string }> {
  const bridge = requireBridge();
  const unsubscribe = bridge.onWhisperProgress((p) => {
    if (p.taskId !== taskId) return;
    onProgress(p.percent, p.eta, p.stage);
  });
  try {
    const res = await bridge.transcribe({ videoPath, taskId });
    if (res.canceled) throw new Error('已取消。');
    if (!res.ok || !res.file) throw new Error(res.error || 'AI 字幕生成失败');
    return { subtitle: toSubtitleSource(res.file, 'ai'), elapsedMs: res.elapsedMs ?? 0, path: res.file.path };
  } finally {
    unsubscribe();
  }
}

export function cancelTranscribe(taskId: number): Promise<boolean> {
  return requireBridge().cancelTranscribe(taskId);
}
