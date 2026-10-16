import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from '../components/Header.tsx';
import SourcePanel from '../components/SourcePanel.tsx';
import SearchBar from '../components/SearchBar.tsx';
import ClipList from '../components/ClipList.tsx';
import PlayerPane from '../components/PlayerPane.tsx';
import Toast from '../components/Toast.tsx';
import InsightPanel from '../components/InsightPanel.tsx';
import SettingsPanel from '../components/SettingsPanel.tsx';
import type { AskResult } from '../components/InsightPanel.tsx';
import { getBridge } from '../services/bridge.ts';
import { clampClipRange, exportClip, onExportProgress } from '../services/exportService.ts';
import { buildClips, extractTerms } from '../utils/clips.ts';
import { detectFfmpeg, pickSubtitle, pickVideo, probeVideo, saveFfmpegPath, toSubtitleSource } from '../services/sourceService.ts';
import {
  analyzeClip,
  analyzeWholeVideo,
  answerQuestion,
  cancelAnalysis,
  expandTopic,
  extractQuestionTerms,
  loadAiStatus,
  onAiProgress,
  saveAiConfig,
  testAiConnection,
  type AiConfigPatch,
} from '../services/aiService.ts';
import {
  DEFAULT_WHISPER_SETTINGS,
  cancelTranscribe,
  detectWhisper,
  extractEmbedded,
  loadWhisperSettings,
  pickWhisperBinary,
  pickWhisperModel,
  probeSubtitles,
  saveWhisperSettings,
  selectModelSize,
  transcribe,
} from '../services/whisperService.ts';
import type { ModelSize, WhisperSettings } from '../services/whisperService.ts';
import { formatClock, sidecarOrigin } from '../utils/format.ts';
import type {
  AiClipInsight,
  AiStatus,
  AiVideoInsight,
  CandidateClip,
  FfmpegStatus,
  SubtitleProbe,
  SubtitleSource,
  VideoSource,
  WhisperStatus,
} from '../types/index.ts';

type Notice = { id: number; kind: 'error' | 'info' | 'success'; text: string };

const EMPTY_WHISPER: WhisperStatus = {
  found: false,
  path: null,
  version: null,
  model: { found: false, path: null, name: null, bytes: 0 },
  checked: false,
};

export default function WorkbenchPage() {
  const bridge = useMemo(() => getBridge(), []);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [video, setVideo] = useState<VideoSource | null>(null);
  const [subtitle, setSubtitle] = useState<SubtitleSource | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus>({ found: false, path: null, version: null, checked: false });
  const [query, setQuery] = useState('');
  const [clips, setClips] = useState<CandidateClip[]>([]);
  const [searched, setSearched] = useState(false);
  const [active, setActive] = useState<CandidateClip | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [autoSearch, setAutoSearch] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [whisper, setWhisper] = useState<WhisperStatus>(EMPTY_WHISPER);
  const [whisperCfg, setWhisperCfg] = useState<WhisperSettings>(DEFAULT_WHISPER_SETTINGS);
  const [probe, setProbe] = useState<SubtitleProbe | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [genPercent, setGenPercent] = useState(0);
  const [genMaxPercent, setGenMaxPercent] = useState(0);
  const [genEta, setGenEta] = useState<number | null>(null);
  const [genStage, setGenStage] = useState('');
  const [lastGen, setLastGen] = useState<{ elapsedMs: number; cues: number } | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [insight, setInsight] = useState<AiVideoInsight | null>(null);
  const [insightStale, setInsightStale] = useState(false);
  const [aiTaskId, setAiTaskId] = useState<number | null>(null);
  const [aiProgress, setAiProgress] = useState<{ percent: number; stage: string } | null>(null);
  const [clipInsights, setClipInsights] = useState<Record<string, AiClipInsight>>({});
  const [analyzingClipId, setAnalyzingClipId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [lastNotice, setLastNotice] = useState<{ kind: Notice['kind']; text: string } | null>(null);

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    const notice: Notice = { id: Date.now() + Math.random(), kind, text };
    setLastNotice({ kind, text });
    setNotices((prev) => [...prev, notice].slice(-3));
    setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== notice.id)), kind === 'error' ? 7000 : 4500);
  }, []);

  useEffect(() => {
    if (!bridge) {
      notify('info', '浏览器预览模式：导入与导出需要 Electron 桌面端能力。');
      return;
    }
    detectFfmpeg()
      .then(setFfmpeg)
      .catch((err) => notify('error', String(err.message || err)));
    loadAiStatus()
      .then(setAi)
      .catch(() => undefined);
    detectWhisper()
      .then(setWhisper)
      .catch(() => undefined);
    loadWhisperSettings()
      .then(setWhisperCfg)
      .catch(() => undefined);
    return onExportProgress((p) => setProgress(p.percent));
  }, [bridge, notify]);

  useEffect(() => {
    if (!bridge) return;
    return onAiProgress((p) => {
      if (p.taskId !== aiTaskId) return;
      setAiProgress({ percent: p.percent, stage: p.stage });
    });
  }, [bridge, aiTaskId]);

  useEffect(() => {
    if (!bridge?.demoLoad) return;
    bridge
      .demoLoad()
      .then(async (file) => {
        if (!file) return;
        setQuery(file.query);
        if (file.video) {
          const source = { ...file.video, probe: await probeVideo(file.video) };
          setVideo(source);
          if (file.skipSubtitle) {
            await analyzeSubtitles(source);
            return;
          }
        }
        setSubtitle(toSubtitleSource(file));
        setAutoSearch(true);
      })
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (!autoSearch || !subtitle || !query.trim()) return;
    setClips(buildClips(subtitle.cues, query));
    setSearched(true);
    setAutoSearch(false);
  }, [autoSearch, subtitle, query]);

  /** 字幕时间轴可能超出视频末尾（AI 段落补白），列表/预览/导出统一按截断后的区间 */
  const displayClips = useMemo(
    () => clips.map((c) => (video ? { ...c, ...clampClipRange(video, c) } : c)),
    [clips, video],
  );

  useEffect(() => {
    window.__TOPICCUT_STATE__ = {
      hasVideo: !!video,
      videoName: video?.name ?? null,
      videoDurationSec: video?.probe?.duration ?? null,
      hasSubtitle: !!subtitle,
      subtitleName: subtitle?.name ?? null,
      subtitleOrigin: subtitle?.origin ?? null,
      cueCount: subtitle?.cues.length ?? 0,
      cueStarts: (subtitle?.cues ?? []).map((c) => c.start),
      clipCount: clips.length,
      clips: displayClips.slice(0, 8).map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        score: c.score,
        hitCount: c.matched.length,
        text: c.matched[0]?.text ?? '',
      })),
      ffmpegFound: ffmpeg.found,
      whisperFound: whisper.found,
      whisperModelFound: whisper.model.found,
      whisperModelName: whisper.model.name ?? null,
      sidecarFound: !!probe?.sidecar,
      embeddedCount: probe?.embedded.length ?? 0,
      hasAudio: probe?.hasAudio ?? null,
      transcribing: taskId !== null,
      genPercent,
      genMaxPercent,
      genEta,
      genStage,
      lastGenElapsedMs: lastGen?.elapsedMs ?? null,
      lastGenCues: lastGen?.cues ?? null,
      aiReady: !!ai?.ready,
      aiModel: ai?.model ?? null,
      aiEndpoint: ai?.endpoint ?? null,
      aiKeyTail: ai?.keyTail ?? null,
      aiAnalyzing: aiTaskId !== null,
      aiPercent: aiProgress?.percent ?? 0,
      aiStage: aiProgress?.stage ?? null,
      aiHasInsight: !!insight,
      insightStale,
      aiSummary: insight?.summary ?? null,
      aiChunks: insight?.chunks ?? 0,
      aiChapterCount: insight?.chapters.length ?? 0,
      aiChapterStart: insight?.chapters[0]?.start ?? null,
      aiChapters: insight?.chapters.map((c) => [c.start, c.end]) ?? [],
      aiThemeCount: insight?.themes.length ?? 0,
      aiKeywordCount: insight?.keywords.length ?? 0,
      aiClipInsightIds: Object.keys(clipInsights),
      asking,
      askKeywords: askResult?.keywords ?? null,
      askClips: askResult?.clips ?? null,
      askAnswer: askResult?.answer ?? null,
      searchQuery: query,
      expanding,
      settingsOpen,
      lastNotice,
    };
  }, [
    video,
    subtitle,
    clips,
    displayClips,
    ffmpeg,
    whisper,
    probe,
    taskId,
    genPercent,
    genMaxPercent,
    genEta,
    genStage,
    lastGen,
    ai,
    aiTaskId,
    aiProgress,
    insight,
    insightStale,
    clipInsights,
    asking,
    askResult,
    query,
    expanding,
    settingsOpen,
    lastNotice,
  ]);

  // 自检通道：只有主进程以 TOPICCUT_SCENARIO=1 启动并带上 ?selfcheck 时才挂载。
  // 这里刻意不写依赖数组：每次渲染都重新登记，测试调到的才是持有最新状态的 handler。
  useEffect(() => {
    if (!bridge || !new URLSearchParams(window.location.search).has('selfcheck')) return;
    window.__TOPICCUT_TEST__ = {
      importVideo: async (filePath: string) => {
        const source = await bridge.videoSource(filePath);
        if (!source) throw new Error('测试通道未能读取视频：' + filePath);
        await importVideoAt(source);
        return window.__TOPICCUT_STATE__;
      },
      /** 点击界面上真实存在的按钮，走的是和用户点击完全相同的 handler */
      clickButton: (label: string) => {
        const target = Array.from(document.querySelectorAll('button')).find(
          (b) => !b.disabled && (b.textContent || '').replace(/\s+/g, '').includes(label.replace(/\s+/g, '')),
        );
        if (!target) return false;
        target.click();
        return true;
      },
      /** 和搜索框回车完全同一条路径 */
      search: (words: string) => {
        setQuery(words);
        setAutoSearch(true);
        return true;
      },
      /** Ask AI 走的是「提问」按钮同一条 handler */
      ask: (question: string) => {
        void handleAsk(question);
        return true;
      },
      analyzeVideo: () => {
        void handleAnalyzeVideo();
        return true;
      },
      testAi: () => handleTestAi(),
      saveAiConfig: async (patch: Record<string, string | boolean>) => {
        const status = await saveAiConfig(patch);
        setAi(status);
        return status;
      },
    };
  });

  const handlePickVideo = async () => {
    try {
      const next = await pickVideo();
      if (!next) return;
      await importVideoAt(next);
      if (/\.mkv$/i.test(next.name)) notify('info', 'MKV 可能无法在内嵌播放器中预览，导出仍可正常工作。');
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  /** 换视频 = 字幕状态归零：先清空旧字幕/结果，再重新探测来源，避免上一个视频（或 demo）的字幕残留 */
  const importVideoAt = async (source: VideoSource) => {
    setSubtitle(null);
    setClips([]);
    setSearched(false);
    setActive(null);
    setProbe(null);
    setInsight(null);
    setInsightStale(false);
    setClipInsights({});
    setAskResult(null);
    setVideo(source);
    const withProbe = { ...source, probe: await probeVideo(source) };
    setVideo(withProbe);
    await analyzeSubtitles(withProbe);
    return withProbe;
  };

  /** 视频 → 同目录字幕 → 内嵌字幕 → 都没有则提示可走本地 AI */
  const analyzeSubtitles = async (source: VideoSource) => {
    try {
      const found = await probeSubtitles(source.path);
      setProbe(found);
      if (found.sidecar) {
        const origin = sidecarOrigin(found.sidecar.name);
        attachSubtitle(
          toSubtitleSource(found.sidecar, origin),
          origin === 'ai'
            ? `已载入上次 AI 生成的字幕 ${found.sidecar.name}，无需重新识别。`
            : `同目录已找到字幕 ${found.sidecar.name}，已自动载入。`,
        );
        return;
      }
      if (found.embedded.length) {
        notify('info', `检测到 ${found.embedded.length} 条内嵌字幕，可一键提取为 SRT。`);
        return;
      }
      notify('info', '未检测到字幕。可以用本地 AI（Whisper.cpp）生成字幕，视频不会离开本机。');
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handleExtractEmbedded = async (streamIndex: number) => {
    if (!video) return;
    try {
      const next = await extractEmbedded(video.path, streamIndex);
      if (!next) return;
      attachSubtitle(next, `已提取内嵌字幕 0:${streamIndex} · ${next.cues.length} 条。`);
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handleGenerateSubtitle = async () => {
    if (!video) {
      notify('error', '请先导入视频。');
      return;
    }
    if (!whisper.found || !whisper.model.found) {
      notify(
        'error',
        !whisper.found
          ? '未检测到 whisper-cli。安装免编译：到 GitHub 的 whisper.cpp releases 下载 whisper-bin-x64.zip 解压，再在左侧「AI 字幕 · 本地」指定 whisper-cli.exe。'
          : `未找到模型 ggml-${whisperCfg.modelSize}.bin。应用不会自动下载模型，请手动下载后在「AI 字幕 · 本地」里选择，或放进 ~/.cache/whisper.cpp。中文建议 small 及以上。`,
      );
      return;
    }
    const id = Date.now();
    setTaskId(id);
    setGenPercent(0);
    setGenMaxPercent(0);
    setGenEta(null);
    setGenStage('准备中');
    try {
      const res = await transcribe(video.path, id, (percent, eta, stage) => {
        setGenPercent(percent);
        setGenMaxPercent((prev) => Math.max(prev, percent));
        setGenEta(eta);
        setGenStage(stage);
      });
      setLastGen({ elapsedMs: res.elapsedMs, cues: res.subtitle.cues.length });
      attachSubtitle(
        res.subtitle,
        `AI 字幕已生成：${res.subtitle.cues.length} 条 · 用时 ${formatClock(res.elapsedMs / 1000)} · ${res.subtitle.name}`,
      );
      if (query.trim()) setAutoSearch(true);
    } catch (err) {
      const message = (err as Error).message;
      if (message === '已取消。') notify('info', '已取消识别：临时音频已清理，没有生成字幕。');
      else notify('error', message);
    } finally {
      setTaskId(null);
      setGenPercent(0);
      setGenEta(null);
      setGenStage('');
    }
  };

  const handleCancelGenerate = async () => {
    if (taskId === null) return;
    try {
      await cancelTranscribe(taskId);
      notify('info', '正在终止 Whisper 进程…');
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handlePickWhisperBinary = async () => {
    try {
      setWhisper(await pickWhisperBinary());
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handlePickWhisperModel = async () => {
    try {
      const next = await pickWhisperModel();
      setWhisper(next);
      // 手动选了具体模型文件时，把「模型大小」同步成它的真实档位，避免下拉框与实际用的模型不一致
      const matched = /ggml-(tiny|base|small|medium)\b/i.exec(next.model.name || '');
      if (matched) setWhisperCfg(await saveWhisperSettings({ modelSize: matched[1] as ModelSize }));
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handleSaveWhisper = async (patch: Partial<WhisperSettings>) => {
    try {
      setWhisperCfg(patch.modelSize ? await selectModelSize(patch.modelSize) : await saveWhisperSettings(patch));
      if (patch.modelSize) setWhisper(await detectWhisper());
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const attachSubtitle = (next: SubtitleSource, note: string) => {
    setSubtitle(next);
    setClips([]);
    setSearched(false);
    setActive(null);
    setInsight(null);
    setInsightStale(false);
    setClipInsights({});
    setAskResult(null);
    notify('success', note);
  };

  const handlePickSubtitle = async () => {
    try {
      const next = await pickSubtitle();
      if (!next) return;
      attachSubtitle(next, `已解析 ${next.cues.length} 条字幕${next.skipped ? `，跳过 ${next.skipped} 条异常` : ''}。`);
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handleSaveFfmpegPath = async (path: string) => {
    try {
      setFfmpeg(await saveFfmpegPath(path));
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handleSaveAi = async (patch: AiConfigPatch) => {
    try {
      setAi(await saveAiConfig(patch));
    } catch (err) {
      notify('error', (err as Error).message);
    }
  };

  const handleTestAi = async () => {
    try {
      const text = await testAiConnection();
      notify('success', text);
      return text;
    } catch (err) {
      notify('error', (err as Error).message);
      throw err;
    }
  };

  /** 自然语言主题 → 关键词列表 → 复用原有字幕检索 */
  const handleExpandTopic = async () => {
    const topic = query.trim();
    if (!subtitle) {
      notify('error', '请先导入字幕，再让 AI 扩展关键词。');
      return;
    }
    if (!topic) {
      notify('error', '先输入一句主题，例如：人工智能如何改变内容行业的工作方式');
      return;
    }
    setExpanding(true);
    try {
      const words = await expandTopic(topic, subtitle.cues);
      setQuery(words.join('，'));
      setAutoSearch(true);
      notify('success', `AI 扩展出 ${words.length} 个关键词：${words.join('、')}`);
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setExpanding(false);
    }
  };

  const handleAnalyzeVideo = async () => {
    if (!subtitle) {
      notify('error', '还没有字幕，AI 无从分析。请先导入字幕或用本地 Whisper 生成。');
      return;
    }
    const id = Date.now();
    setAiTaskId(id);
    setAiProgress({ percent: 0, stage: '准备中' });
    try {
      const res = await analyzeWholeVideo(subtitle.cues, id);
      setInsight(res);
      setInsightStale(false);
      notify(
        'success',
        `AI 全片分析完成：${res.chunks} 段 · ${res.chapters.length} 个章节 · 用时 ${formatClock(res.elapsedMs / 1000)}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      // 失败时保留上一次成功的结论，但必须标出来它已经不代表当前字幕
      setInsightStale((prev) => prev || !!insight);
      notify(message === '已取消。' ? 'info' : 'error', message);
    } finally {
      setAiTaskId(null);
      setAiProgress(null);
    }
  };

  const handleCancelAnalyze = async () => {
    if (aiTaskId === null) return;
    await cancelAnalysis(aiTaskId);
    notify('info', '正在取消 AI 分析…');
  };

  const handleAnalyzeClip = async (clip: CandidateClip) => {
    try {
      const res = await analyzeClip(clip.cues);
      setClipInsights((prev) => ({ ...prev, [clip.id]: res }));
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setAnalyzingClipId(null);
    }
  };

  /**
   * Ask AI：模型只负责"问题 → 检索词"和"依据引文写答案"。
   * 片段与时间一律由本地 buildClips 在真实字幕里算出来。
   */
  const handleAsk = async (question: string) => {
    if (!subtitle) {
      notify('error', '还没有字幕，无法基于内容回答。');
      return;
    }
    setAsking(true);
    try {
      const keywords = await extractQuestionTerms(question, subtitle.cues);
      const result = buildClips(subtitle.cues, keywords.join('，'));
      setClips(result);
      setSearched(true);
      setActive(null);
      setQuery(keywords.join('，'));
      // 没有命中就没有引文：这时绝不拿无关字幕凑证据，让模型硬答会编出内容
      const evidence = result.flatMap((c) => c.matched.map((m) => m.text));
      const res = await answerQuestion(question, evidence);
      setAskResult({ question, answer: res.answer, keywords, clips: result.length });
      if (!result.length) notify('info', `字幕里没有检索到与「${keywords.join('、')}」相关的内容。`);
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const handleUseKeyword = (term: string) => {
    setQuery(term);
    setAutoSearch(true);
  };

  const handleSeekTime = (sec: number) => {
    if (!video) {
      notify('error', '还没有导入视频，无法定位播放。');
      return;
    }
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = sec;
    void el.play().catch(() => undefined);
  };

  const handleSearch = () => {
    if (!subtitle) {
      notify('error', '还没有导入字幕文件。字幕是本工具的唯一检索依据，请先导入 .srt。');
      return;
    }
    if (!query.trim()) {
      notify('error', '请输入关键词或主题。');
      return;
    }
    const result = buildClips(subtitle.cues, query);
    setClips(result);
    setSearched(true);
    setActive(null);
    if (result.length === 0) {
      const alternatives = extractTerms(query)
        .map((t) => subtitle.cues.find((c) => c.text.toLowerCase().includes(t.slice(0, 2).toLowerCase()))?.text)
        .filter(Boolean);
      notify(
        'info',
        alternatives.length
          ? `未命中。字幕中出现过相近内容：${String(alternatives[0]).slice(0, 40)}…`
          : `未在 ${subtitle.cues.length} 条字幕中找到「${query.trim()}」。`,
      );
    } else {
      notify('success', `找到 ${result.length} 个候选片段。`);
    }
  };

  const handleSelect = (clip: CandidateClip) => {
    setActive(clip);
    if (!video) {
      notify('error', '还没有导入视频文件，无法预览或导出。');
      return;
    }
    const el = videoRef.current;
    if (el) {
      el.currentTime = clip.start;
      void el.play().catch(() => undefined);
    }
  };

  const handleExport = async (clip: CandidateClip) => {
    if (!video) {
      notify('error', '还没有导入视频文件，无法导出。');
      return;
    }
    if (!ffmpeg.found) {
      notify('error', '未检测到 FFmpeg。请在左侧「导出引擎」中填写 ffmpeg.exe 路径，或先安装 FFmpeg。');
      return;
    }
    setExportingId(clip.id);
    setProgress(0);
    try {
      const res = await exportClip(video, clip);
      if (res.canceled) notify('info', '已取消导出。');
      else if (res.ok) notify('success', `导出完成：${formatClock(clip.end - clip.start)} · ${res.output}`);
      else notify('error', res.error || '导出失败');
    } catch (err) {
      notify('error', (err as Error).message);
    } finally {
      setExportingId(null);
      setProgress(null);
    }
  };

  const hint = subtitle
    ? `字幕 ${subtitle.cues.length} 条 · 相邻间隔 < 10 秒自动合并 · 前后各保留 1 条上下文${
        subtitle.origin === 'ai' ? ' · AI 字幕可能有错字，搜不到时换更短或更口语的词' : ''
      }`
    : video && probe?.hasAudio
      ? '这个视频还没有字幕：点左侧「生成 AI 字幕」，用本地 Whisper 生成后即可搜索'
      : '导入字幕后即可搜索；没有字幕的视频也可以导入，用本地 AI 生成字幕';

  return (
    <div className="flex h-full flex-col">
      <Header
        ffmpegFound={ffmpeg.found}
        ffmpegVersion={ffmpeg.version}
        whisperReady={whisper.found && whisper.model.found}
        aiReady={!!ai?.ready}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <SourcePanel
          video={video}
          subtitle={subtitle}
          ffmpeg={ffmpeg}
          ai={ai}
          probe={probe}
          whisper={whisper}
          whisperCfg={whisperCfg}
          generating={taskId !== null}
          genPercent={genPercent}
          genEta={genEta}
          genStage={genStage}
          onPickVideo={handlePickVideo}
          onPickSubtitle={handlePickSubtitle}
          onSaveFfmpegPath={handleSaveFfmpegPath}
          onOpenSettings={() => setSettingsOpen(true)}
          onGenerate={handleGenerateSubtitle}
          onCancelGenerate={handleCancelGenerate}
          onExtractEmbedded={handleExtractEmbedded}
          onPickWhisperBinary={handlePickWhisperBinary}
          onPickWhisperModel={handlePickWhisperModel}
          onSaveWhisper={handleSaveWhisper}
        />

        <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8 scrollbar-thin">
          <SearchBar
            value={query}
            disabled={!subtitle}
            hint={hint}
            aiReady={!!ai?.ready}
            expanding={expanding}
            onChange={setQuery}
            onSearch={handleSearch}
            onExpand={handleExpandTopic}
          />

          <InsightPanel
            aiReady={!!ai?.ready}
            hasSubtitle={!!subtitle}
            cueCount={subtitle?.cues.length ?? 0}
            insight={insight}
            insightStale={insightStale}
            analyzing={aiTaskId !== null}
            progress={aiProgress}
            asking={asking}
            askResult={askResult}
            onAnalyze={handleAnalyzeVideo}
            onCancel={handleCancelAnalyze}
            onAsk={handleAsk}
            onUseKeyword={handleUseKeyword}
            onOpenSettings={() => setSettingsOpen(true)}
            onSeekChapter={handleSeekTime}
          />

          <div className="mt-9 flex items-baseline justify-between">
            <h2 className="text-[13px] uppercase tracking-[0.28em] text-slate-500">推荐片段</h2>
            <span className="text-[12px] text-slate-600">
              {clips.length > 0 ? `${clips.length} 个建议 · 按相关度排序` : ''}
            </span>
          </div>

          <div className="mt-5">
            <ClipList
              clips={displayClips}
              searched={searched}
              activeId={active?.id ?? null}
              exportingId={exportingId}
              progress={progress}
              canExport={!!video && ffmpeg.found && !!bridge}
              aiReady={!!ai?.ready}
              analyzingId={analyzingClipId}
              insights={clipInsights}
              onSelect={handleSelect}
              onExport={handleExport}
              onAnalyze={(clip) => {
                setAnalyzingClipId(clip.id);
                void handleAnalyzeClip(clip);
              }}
            />
          </div>
        </main>

        <div className="w-[420px] shrink-0 border-l border-white/[0.06] px-7 py-8">
          <PlayerPane video={video} clip={active} cues={subtitle?.cues ?? []} videoRef={videoRef} />
        </div>
      </div>

      <Toast items={notices} onDismiss={() => setNotices([])} />
      <SettingsPanel
        open={settingsOpen}
        ai={ai}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveAi}
        onTest={handleTestAi}
      />
    </div>
  );
}
