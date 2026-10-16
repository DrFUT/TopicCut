interface Props {
  ffmpegFound: boolean;
  ffmpegVersion: string | null;
  whisperReady: boolean;
  aiReady: boolean;
  onOpenSettings: () => void;
}

function Dot({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-300/80' : 'bg-amber-300/70'}`} />
      <span>{text}</span>
    </span>
  );
}

/** FFmpeg 的 version 串很长（含 build 后缀与站点名），状态点只留主版本号 */
function ffmpegLabel(version: string | null): string {
  const m = /version\s+([A-Za-z]?\d[^\s-]*)/.exec(version || '');
  return m ? `FFmpeg ${m[1]}` : 'FFmpeg 就绪';
}

export default function Header({ ffmpegFound, ffmpegVersion, whisperReady, aiReady, onOpenSettings }: Props) {
  return (
    <header className="flex items-center justify-between border-b border-white/[0.06] px-10 py-6">
      <div className="flex items-baseline gap-4">
        <h1 className="text-[22px] font-light tracking-[0.22em] text-slate-50">
          Topic<span className="text-amber-100/80">Cut</span>
        </h1>
        <span className="text-[11px] uppercase widest2 tracking-[0.32em] text-slate-600">
          字幕驱动的片段发现
        </span>
      </div>

      <div className="flex items-center gap-5 text-[11px] tracking-wide text-slate-500">
        <Dot ok={whisperReady} text={whisperReady ? '本地 AI 字幕就绪' : '本地 AI 字幕未安装'} />
        <Dot ok={ffmpegFound} text={ffmpegFound ? ffmpegLabel(ffmpegVersion) : 'FFmpeg 未检测到'} />
        <Dot ok={aiReady} text={aiReady ? 'AI 理解已配置' : 'AI 理解未配置'} />
        <button className="btn px-4 py-1.5 text-[11px]" onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </header>
  );
}
