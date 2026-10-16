import { requireBridge } from './bridge.ts';
import type { AiClipInsight, AiProgress, AiStatus, AiVideoInsight, SubtitleCue } from '../types/index.ts';

/**
 * 渲染层不直接碰 AI 接口：所有调用交给主进程（electron/services/ai.cjs）。
 * 好处是密钥只存在于主进程，且自定义 endpoint 不受渲染层 CORS 限制。
 */

export const AI_UNAVAILABLE = 'AI 能力需要桌面端：请在 Electron 中运行（npm run dev）。';

function needBridge() {
  const bridge = typeof window !== 'undefined' ? window.topiccut : null;
  if (!bridge) throw new Error(AI_UNAVAILABLE);
  return requireBridge();
}

function unwrap<T>(res: { ok: boolean; data?: T; error?: string }, fallback: string): T {
  if (!res.ok || !res.data) throw new Error(res.error || fallback);
  return res.data;
}

export async function loadAiStatus(): Promise<AiStatus> {
  return needBridge().aiStatus();
}

export type AiConfigPatch = Partial<{
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  /** 界面「删除密钥」用的显式动作：留空只是"不修改"，删除必须是主动的 */
  clearApiKey: boolean;
}>;

export async function saveAiConfig(patch: AiConfigPatch): Promise<AiStatus> {
  return needBridge().saveAiConfig(patch);
}

export async function testAiConnection(): Promise<string> {
  const res = await needBridge().testAi();
  if (!res.ok) throw new Error(res.error || 'AI 接口连接失败。');
  return `连接成功：${res.model} · ${((res.latencyMs || 0) / 1000).toFixed(1)} 秒 · 回复「${res.sample}」`;
}

export function onAiProgress(handler: (p: AiProgress) => void): () => void {
  return needBridge().onAiProgress(handler);
}

export async function analyzeWholeVideo(cues: SubtitleCue[], taskId: number): Promise<AiVideoInsight> {
  return unwrap(await needBridge().aiAnalyzeVideo({ cues, taskId }), 'AI 全片分析失败。');
}

export function cancelAnalysis(taskId: number): Promise<boolean> {
  return needBridge().cancelAi(taskId);
}

export async function analyzeClip(cues: SubtitleCue[]): Promise<AiClipInsight> {
  return unwrap(await needBridge().aiAnalyzeClip({ cues }), 'AI 片段分析失败。');
}

/** 问题 → 检索关键词：时间轴不在这一步产生 */
export async function extractQuestionTerms(question: string, cues: SubtitleCue[]): Promise<string[]> {
  const res = await needBridge().aiQuestionTerms({ question, cues });
  if (!res.ok || !res.keywords) throw new Error(res.error || 'AI 未能理解这个问题。');
  return res.keywords;
}

export async function answerQuestion(
  question: string,
  evidence: string[],
): Promise<{ answer: string; timestampsRemoved: boolean }> {
  const res = await needBridge().aiAnswer({ question, evidence });
  if (!res.ok || !res.answer) throw new Error(res.error || 'AI 未能给出回答。');
  return { answer: res.answer, timestampsRemoved: !!res.timestampsRemoved };
}

export async function expandTopic(topic: string, cues: SubtitleCue[]): Promise<string[]> {
  const res = await needBridge().aiExpandTopic({ topic, cues });
  if (!res.ok || !res.keywords) throw new Error(res.error || 'AI 没有返回可用关键词。');
  return res.keywords;
}
