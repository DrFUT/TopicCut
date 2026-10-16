import type { ChangeEvent } from 'react';

interface Props {
  value: string;
  disabled: boolean;
  hint: string;
  aiReady: boolean;
  expanding: boolean;
  onChange: (v: string) => void;
  onSearch: () => void;
  onExpand: () => void;
}

export default function SearchBar({
  value,
  disabled,
  hint,
  aiReady,
  expanding,
  onChange,
  onSearch,
  onExpand,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <input
          className="field h-12 flex-1 rounded-full bg-white/[0.03] px-6 text-[15px] tracking-wide placeholder:text-slate-600"
          placeholder="关键词，或一句自然语言主题（可用 AI 扩展）"
          value={value}
          disabled={disabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSearch()}
        />
        <button
          className="btn h-12 px-5 whitespace-nowrap"
          disabled={disabled || expanding || !value.trim()}
          onClick={onExpand}
          title={aiReady ? '把主题扩展成多个检索关键词' : '未配置 API Key，可在左侧「AI 增强」填写'}
        >
          {expanding ? '扩展中…' : 'AI 扩展'}
        </button>
        <button className="btn btn-primary h-12 px-7" disabled={disabled || !value.trim()} onClick={onSearch}>
          搜索
        </button>
      </div>
      <p className="pl-2 text-[11px] tracking-wide text-slate-600">{hint}</p>
    </div>
  );
}
