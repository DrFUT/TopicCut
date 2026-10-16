export interface SubtitleCue {
  seq: number;
  start: number;
  end: number;
  text: string;
}

export interface ProbeInfo {
  duration: number | null;
  size: number | null;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  vcodec: string | null;
}

export interface VideoSource {
  path: string;
  name: string;
  dir: string;
  bytes: number;
  mtime: number;
  probe: ProbeInfo | null;
  mediaUrl: string;
}

export interface SubtitleFile {
  path: string;
  name: string;
  bytes: number;
  text: string;
}

/** 字幕来源：手动导入 / 同目录外挂 / 视频内嵌 / 本地 AI 生成 */
export type SubtitleOrigin = 'manual' | 'sidecar' | 'embedded' | 'ai';

export interface SubtitleSource {
  path: string;
  name: string;
  bytes: number;
  cues: SubtitleCue[];
  skipped: number;
  origin: SubtitleOrigin;
  /** origin === 'embedded' 时的容器流序号 */
  streamIndex?: number;
}

export interface CandidateClip {
  id: string;
  start: number;
  end: number;
  terms: string[];
  matched: SubtitleCue[];
  cues: SubtitleCue[];
  score: number;
}

/** 主进程返回的 AI 配置视图：密钥只给"有没有配 / 末 4 位"，绝不下发原文 */
export interface AiStatus {
  provider: string;
  endpoint: string;
  model: string;
  hasKey: boolean;
  keyTail: string | null;
  ready: boolean;
  providers: { id: string; label: string; endpoint: string; model: string }[];
}

export interface AiChapter {
  start: number;
  end: number;
  title: string;
  summary: string;
}

/** 全片分析结果：章节时间来自字幕真实边界 */
export interface AiVideoInsight {
  summary: string;
  themes: string[];
  keywords: string[];
  chapters: AiChapter[];
  chunks: number;
  coarsened: boolean;
  elapsedMs: number;
}

export interface AiClipInsight {
  summary: string;
  points: string[];
  useCases: string[];
}

export interface AiProgress {
  taskId: number;
  percent: number;
  stage: string;
}

export interface EmbeddedSubtitle {
  index: number;
  lang: string | null;
  codec: string;
}

export interface SubtitleProbe {
  sidecar: SubtitleFile | null;
  embedded: EmbeddedSubtitle[];
  /** null = 没有 FFmpeg，无法判断有没有音轨 */
  hasAudio: boolean | null;
}

export interface WhisperModelInfo {
  found: boolean;
  path: string | null;
  name: string | null;
  bytes: number;
}

export interface WhisperStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  model: WhisperModelInfo;
  checked: boolean;
}

export interface TranscribeResult {
  ok: boolean;
  canceled?: boolean;
  file?: SubtitleFile;
  elapsedMs?: number;
  error?: string;
}

export interface TranscribeProgress {
  taskId: number;
  percent: number;
  eta: number | null;
  stage: string;
}

export interface FfmpegStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  checked: boolean;
}

export interface ExportResult {
  ok: boolean;
  canceled?: boolean;
  output?: string;
  bytes?: number;
  error?: string;
}

export interface BridgeApi {
  pickVideo(): Promise<VideoSource | null>;
  pickSubtitle(): Promise<SubtitleFile | null>;
  detectFfmpeg(): Promise<FfmpegStatus>;
  probe(path: string): Promise<ProbeInfo | null>;
  getSettings(): Promise<Record<string, unknown>>;
  saveSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  exportClip(payload: {
    input: string;
    start: number;
    end: number;
    suggestedName: string;
  }): Promise<ExportResult>;
  reveal(path: string): Promise<void>;
  probeSubtitles(videoPath: string): Promise<SubtitleProbe>;
  /** 仅自检模式可用：跳过文件对话框，按路径构造与 pickVideo 相同的视频信息 */
  videoSource(path: string): Promise<VideoSource | null>;
  extractEmbedded(payload: {
    videoPath: string;
    streamIndex: number;
  }): Promise<{ ok: boolean; canceled?: boolean; file?: SubtitleFile; error?: string }>;
  detectWhisper(): Promise<WhisperStatus>;
  pickWhisperBinary(): Promise<WhisperStatus>;
  pickWhisperModel(): Promise<WhisperStatus>;
  transcribe(payload: { videoPath: string; taskId: number }): Promise<TranscribeResult>;
  cancelTranscribe(taskId: number): Promise<boolean>;
  onWhisperProgress(handler: (p: TranscribeProgress) => void): () => void;
  aiStatus(): Promise<AiStatus>;
  saveAiConfig(
    patch: Partial<{ provider: string; endpoint: string; model: string; apiKey: string; clearApiKey: boolean }>,
  ): Promise<AiStatus>;
  testAi(): Promise<{ ok: boolean; model?: string; latencyMs?: number; sample?: string; error?: string }>;
  aiAnalyzeVideo(payload: { cues: SubtitleCue[]; taskId: number }): Promise<{ ok: boolean; data?: AiVideoInsight; canceled?: boolean; error?: string }>;
  aiAnalyzeClip(payload: { cues: SubtitleCue[] }): Promise<{ ok: boolean; data?: AiClipInsight; error?: string }>;
  aiQuestionTerms(payload: { question: string; cues: SubtitleCue[] }): Promise<{ ok: boolean; keywords?: string[]; error?: string }>;
  aiAnswer(payload: { question: string; evidence: string[] }): Promise<{ ok: boolean; answer?: string; timestampsRemoved?: boolean; error?: string }>;
  aiExpandTopic(payload: { topic: string; cues: SubtitleCue[] }): Promise<{ ok: boolean; keywords?: string[]; error?: string }>;
  cancelAi(taskId: number): Promise<boolean>;
  onAiProgress(handler: (p: AiProgress) => void): () => void;
  demoLoad?(): Promise<(SubtitleFile & { query: string; video: VideoSource | null; skipSubtitle?: boolean }) | null>;
  onExportProgress(handler: (p: { start: number; end: number; percent: number }) => void): () => void;
}

declare global {
  interface Window {
    topiccut?: BridgeApi;
    __TOPICCUT_STATE__?: Record<string, unknown>;
    __TOPICCUT_TEST__?: {
      importVideo(path: string): Promise<Record<string, unknown> | undefined>;
      clickButton(label: string): boolean;
      search(words: string): boolean;
      ask(question: string): boolean;
      analyzeVideo(): boolean;
      testAi(): Promise<string>;
      saveAiConfig(patch: Record<string, string | boolean>): Promise<AiStatus>;
    };
  }
}
