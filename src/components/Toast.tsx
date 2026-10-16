interface Props {
  items: { kind: 'error' | 'info' | 'success'; text: string }[];
  onDismiss: () => void;
}

const TONE = {
  error: 'border-rose-300/25 text-rose-100/90',
  success: 'border-emerald-300/25 text-emerald-100/90',
  info: 'border-white/[0.12] text-slate-300',
} as const;

export default function Toast({ items, onDismiss }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex flex-col items-center gap-2">
      {items.map((item, i) => (
        <button
          key={`${i}-${item.text}`}
          onClick={onDismiss}
          className={`pointer-events-auto max-w-[720px] rounded-full border bg-black/80 px-6 py-2.5 text-[12.5px] leading-relaxed tracking-wide backdrop-blur ${TONE[item.kind]}`}
        >
          {item.text}
        </button>
      ))}
    </div>
  );
}
