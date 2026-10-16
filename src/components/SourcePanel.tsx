import { formatBytes, formatClock, subtitleSourceText } from '../utils/format.ts';
import { MODEL_SIZES } from '../services/whisperService.ts';
import type { ModelSize, WhisperSettings } from '../services/whisperService.ts';
import type {
  AiStatus,
  FfmpegStatus,
  SubtitleProbe,
  SubtitleSource,
  VideoSource,
  WhisperStatus,
} from '../types/index.ts';

/** 档位说明来自本机实测：3 分钟真实中文电影音频，whisper-cli -t 4 */
const MODEL_NOTES: Record<ModelSize, { label: string; note: string }> = {
  tiny: { label: 'tiny · 74 MB', note: '最快（实测 12× 实时），中文错字多、易出繁体' },
  base: { label: 'base · 141 MB', note: '快（实测 11× 实时），但中文常错词，只适合粗定位' },
  small: { label: 'small · 465 MB · 中文推荐', note: '慢（本机端到端实测 1.4~3× 实时），中文转写可用' },
  medium: { label: 'medium · 1.5 GB', note: '更准但更慢，长片请先试片段' },
};

interface Props {
  video: VideoSource | null;
  subtitle: SubtitleSource | null;
  ffmpeg: FfmpegStatus;
  ai: AiStatus | null;
  probe: SubtitleProbe | null;
  whisper: WhisperStatus;
  whisperCfg: WhisperSettings;
  generating: boolean;
  genPercent: number;
  genEta: number | null;
  genStage: string;
  onPickVideo: () => void;
  onPickSubtitle: () => void;
  onSaveFfmpegPath: (path: string) => void;
  onOpenSettings: () => void;
  onGenerate: () => void;
  onCancelGenerate: () => void;
  onExtractEmbedded: (streamIndex: number) => void;
  onPickWhisperBinary: () => void;
  onPickWhisperModel: () => void;
  onSaveWhisper: (patch: Partial<WhisperSettings>) => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-slate-600">{label}</span>
      <span className="break-all text-right text-[12px] text-slate-300">{value}</span>
    </div>
  );
}

function StatusLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={`text-[12px] leading-relaxed ${ok ? 'text-emerald-200/80' : 'text-slate-400'}`}>
      {ok ? '✓ ' : '· '}
      {text}
    </p>
  );
}

export default function SourcePanel({
  video,
  subtitle,
  ffmpeg,
  ai,
  probe,
  whisper,
  whisperCfg,
  generating,
  genPercent,
  genEta,
  genStage,
  onPickVideo,
  onPickSubtitle,
  onSaveFfmpegPath,
  onOpenSettings,
  onGenerate,
  onCancelGenerate,
  onExtractEmbedded,
  onPickWhisperBinary,
  onPickWhisperModel,
  onSaveWhisper,
}: Props) {
  const ready = whisper.found && whisper.model.found;

  return (
    <aside className="flex w-[300px] shrink-0 flex-col gap-8 overflow-y-auto border-r border-white/[0.06] px-7 py-8 scrollbar-thin">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="label">素材源</h2>
        </div>

        <div className="space-y-3">
          <button className="btn w-full" onClick={onPickVideo}>
            导入视频
          </button>
          {video ? (
            <div className="panel px-4 py-3">
              <Row label="文件" value={video.name} />
              <Row label="大小" value={formatBytes(video.bytes)} />
              <Row
                label="时长"
                value={video.probe?.duration ? formatClock(video.probe.duration) : '未知'}
              />
              <Row
                label="分辨率"
                value={video.probe?.width ? `${video.probe.width}×${video.probe.height}` : '未知'}
              />
              <p className="mt-2 break-all text-[10px] leading-relaxed text-slate-600">{video.path}</p>
            </div>
          ) : (
            <p className="text-[12px] leading-relaxed text-slate-600">
              支持 .mp4 / .mkv / .mov，尚未导入视频。
            </p>
          )}
        </div>

        <div className="space-y-3">
          <button className="btn w-full" onClick={onPickSubtitle}>
            导入 SRT 字幕
          </button>
          {subtitle ? (
            <div className="panel px-4 py-3">
              <Row label="来源" value={subtitleSourceText(subtitle.origin, subtitle.name, subtitle.streamIndex)} />
              <Row label="字幕条数" value={String(subtitle.cues.length)} />
              <Row
                label="覆盖"
                value={`${formatClock(subtitle.cues[0].start)} - ${formatClock(
                  subtitle.cues[subtitle.cues.length - 1].end,
                )}`}
              />
              {subtitle.skipped > 0 && <Row label="跳过" value={`${subtitle.skipped} 条格式异常`} />}
            </div>
          ) : (
            <p className="text-[12px] leading-relaxed text-slate-600">
              仅支持 .srt。字幕是片段发现的唯一依据，没有字幕时可由本地 AI 生成。
            </p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="label">字幕状态</h2>
        {!video ? (
          <p className="text-[12px] leading-relaxed text-slate-600">导入视频后自动检测同目录与内嵌字幕。</p>
        ) : generating ? (
          <div className="panel space-y-2 px-4 py-3">
            <p className="text-[12px] text-slate-300">正在识别语音… {genStage}</p>
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-slate-200/70 transition-all" style={{ width: `${genPercent}%` }} />
            </div>
            <p className="text-[11px] text-slate-500">
              {genPercent}%{genEta !== null ? ` · 预计剩余 ${formatClock(genEta)}` : ''}
            </p>
            <button className="btn w-full py-1.5 text-[12px]" onClick={onCancelGenerate}>
              取消
            </button>
          </div>
        ) : subtitle ? (
          <StatusLine ok text={`已找到字幕 · ${subtitleSourceText(subtitle.origin, subtitle.name, subtitle.streamIndex)}`} />
        ) : probe?.embedded?.length ? (
          <div className="space-y-2">
            <p className="text-[12px] leading-relaxed text-slate-400">
              检测到 {probe.embedded.length} 条内嵌字幕，提取为 SRT 后即可检索。
            </p>
            {probe.embedded.map((s) => (
              <button
                key={s.index}
                className="btn w-full py-1.5 text-[12px]"
                onClick={() => onExtractEmbedded(s.index)}
              >
                {`提取内嵌字幕 Stream 0:${s.index}${s.lang ? ` (${s.lang})` : ''}`}
              </button>
            ))}
          </div>
        ) : probe && probe.hasAudio === false ? (
          <p className="text-[12px] leading-relaxed text-slate-400">
            未检测到字幕，且这个视频没有音轨，AI 也无法识别。请换含声音的源文件。
          </p>
        ) : probe ? (
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-slate-400">
              未检测到字幕。是否使用本地 AI 生成字幕？音频与视频全程不离开本机。
            </p>
            <button className="btn btn-primary w-full" onClick={onGenerate} disabled={!ready}>
              生成 AI 字幕
            </button>
            <p className="text-[10px] leading-relaxed text-slate-600">
              耗时参考（本机实测）：small 档 CPU 1.4~3× 实时，10 分钟视频约 3~7 分钟；base 档约 11× 实时但中文常错词。
            </p>
            {!ready && (
              <p className="text-[10px] leading-relaxed text-slate-600">
                {whisper.found ? '缺少模型文件' : '缺少 whisper-cli'}，见下方「AI 字幕」设置。
              </p>
            )}
          </div>
        ) : (
          <p className="text-[12px] leading-relaxed text-slate-600">检测中…</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="label">导出引擎</h2>
        <p className="text-[12px] leading-relaxed text-slate-400">
          {ffmpeg.found ? (
            <>
              已就绪 · <span className="text-slate-500">{ffmpeg.path}</span>
            </>
          ) : (
            '未检测到系统 FFmpeg，导出功能不可用。可手动指定可执行文件路径。'
          )}
        </p>
        <input
          className="field"
          placeholder={ffmpeg.path || 'C:\\ffmpeg\\bin\\ffmpeg.exe'}
          defaultValue={ffmpeg.path || ''}
          onBlur={(e) => e.target.value.trim() && onSaveFfmpegPath(e.target.value.trim())}
        />
        <p className="text-[10px] leading-relaxed text-slate-600">
          离开输入框后重新检测。也可安装：winget install Gyan.FFmpeg
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="label">AI 字幕 · 本地</h2>
        <StatusLine
          ok={whisper.found}
          text={whisper.found ? `whisper-cli 已就绪${whisper.version ? ' · ' + whisper.version : ''}` : '未找到 whisper-cli'}
        />
        {whisper.found && <p className="break-all text-[10px] leading-relaxed text-slate-600">{whisper.path}</p>}
        <StatusLine
          ok={whisper.model.found}
          text={
            whisper.model.found
              ? `模型 ${whisper.model.name} · ${formatBytes(whisper.model.bytes)}`
              : '未找到模型（ggml-*.bin）'
          }
        />
        <div className="grid grid-cols-2 gap-2">
          <button className="btn px-3 py-1.5 text-[12px]" onClick={onPickWhisperBinary}>
            选择程序
          </button>
          <button className="btn px-3 py-1.5 text-[12px]" onClick={onPickWhisperModel}>
            选择模型
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select
            className="field"
            value={whisperCfg.modelSize}
            onChange={(e) => onSaveWhisper({ modelSize: e.target.value as WhisperSettings['modelSize'] })}
          >
            {MODEL_SIZES.map((s) => (
              <option key={s} value={s}>
                {MODEL_NOTES[s].label}
              </option>
            ))}
          </select>
          <select
            className="field"
            value={whisperCfg.language}
            onChange={(e) => onSaveWhisper({ language: e.target.value })}
          >
            <option value="auto">自动语言</option>
            <option value="zh">中文</option>
            <option value="en">英文</option>
          </select>
        </div>
        <p className="text-[10px] leading-relaxed text-slate-600">
          {whisper.model.found
            ? `当前模型档位 ${whisperCfg.modelSize}：${MODEL_NOTES[whisperCfg.modelSize].note}`
            : `未找到 ggml-${whisperCfg.modelSize}.bin。放到 ~/.cache/whisper.cpp 即可自动识别，或用上方「选择模型」指定位置。`}
        </p>
        <p className="text-[10px] leading-relaxed text-slate-600">
          安装（免编译）：GitHub whisper.cpp releases 下载 whisper-bin-x64.zip 解压；模型在
          huggingface.co/ggerganov/whisper.cpp 取 ggml-small.bin（约 465 MB）。应用不会自动下载任何模型。
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="label">AI 理解 · 云端</h2>
        <StatusLine
          ok={!!ai?.ready}
          text={
            ai?.ready
              ? `已配置 · ${ai.model}`
              : ai && !ai.hasKey
                ? '未配置 API Key，AI 分析保持禁用'
                : '检测中…'
          }
        />
        {ai?.ready && <p className="break-all text-[10px] leading-relaxed text-slate-600">{ai.endpoint}</p>}
        <button className="btn w-full py-1.5 text-[12px]" onClick={onOpenSettings}>
          打开设置
        </button>
        <p className="text-[10px] leading-relaxed text-slate-600">
          用于全片分析、片段分析与 Ask AI。密钥仅保存在本机，字幕检索与导出不需要它。
        </p>
      </section>
    </aside>
  );
}
