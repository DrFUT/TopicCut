import { useEffect, useState } from 'react';
import type { AiStatus } from '../types/index.ts';
import type { AiConfigPatch } from '../services/aiService.ts';

interface Props {
  open: boolean;
  ai: AiStatus | null;
  onClose: () => void;
  onSave: (patch: AiConfigPatch) => Promise<void>;
  onTest: () => Promise<string>;
}

/**
 * AI Provider 设置：endpoint / model / key 全部由用户填写，代码里不写死任何密钥。
 * 选择预置厂商只是把地址和默认模型名填进输入框，仍可再改。
 */
export default function SettingsPanel({ open, ai, onClose, onSave, onTest }: Props) {
  const [provider, setProvider] = useState('openai');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open || !ai) return;
    setProvider(ai.provider);
    setEndpoint(ai.endpoint);
    setModel(ai.model);
    setApiKey('');
    setResult(null);
  }, [open, ai]);

  if (!open || !ai) return null;

  const preset = (id: string) => ai.providers.find((p) => p.id === id);

  const pickProvider = async (id: string) => {
    setProvider(id);
    const p = preset(id);
    if (!p || !p.endpoint) return;
    setEndpoint(p.endpoint);
    if (p.model) setModel(p.model);
    await onSave({ provider: id, endpoint: p.endpoint, model: p.model || undefined });
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        provider,
        endpoint: endpoint.trim(),
        model: model.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey('');
      setResult({ ok: true, text: '已保存到本机配置。' });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    setResult(null);
    try {
      await onSave({ clearApiKey: true });
      setApiKey('');
      setResult({ ok: true, text: '已从本机删除密钥，AI 功能回到禁用状态。字幕检索与导出不受影响。' });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: true, text: await onTest() });
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-6" onClick={onClose}>
      <div
        className="panel max-h-[86vh] w-[560px] overflow-y-auto bg-ink/95 px-8 py-7 scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-[15px] uppercase tracking-[0.26em] text-slate-200">设置</h2>
          <button className="btn px-4 py-1.5 text-[12px]" onClick={onClose}>
            关闭
          </button>
        </div>

        <section className="mt-6 space-y-3">
          <h3 className="label">AI Provider</h3>
          <div className="grid grid-cols-3 gap-2">
            {ai.providers.map((p) => (
              <button
                key={p.id}
                className={`btn px-3 py-1.5 text-[12px] ${provider === p.id ? 'btn-primary' : ''}`}
                onClick={() => void pickProvider(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="block space-y-1">
            <span className="label">Endpoint</span>
            <input
              className="field"
              placeholder="https://api.openai.com/v1 或完整 /chat/completions 地址"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="label">Model</span>
            <input
              className="field"
              placeholder="gpt-4o-mini / deepseek-chat / 自定义模型名"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="label">API Key</span>
            <input
              className="field"
              type="password"
              placeholder={ai.hasKey ? `已保存（末 4 位 ${ai.keyTail}），留空表示不修改` : '仅保存在本机'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>

          <div className="flex items-center gap-3 pt-1">
            <button className="btn btn-primary px-5 py-2" disabled={busy} onClick={() => void save()}>
              保存
            </button>
            <button className="btn px-5 py-2" disabled={busy || !ai.ready} onClick={() => void test()}>
              测试连接
            </button>
            {ai.hasKey && (
              <button className="btn px-4 py-2 text-[12px]" disabled={busy} onClick={() => void removeKey()}>
                删除密钥
              </button>
            )}
            <span className="text-[11px] text-slate-500">
              {ai.ready ? `当前：${ai.model}` : '未配置完整，AI 功能保持禁用'}
            </span>
          </div>

          {result && (
            <p className={`text-[12px] leading-relaxed ${result.ok ? 'text-emerald-200/80' : 'text-rose-200/90'}`}>
              {result.ok ? '✓ ' : '× '}
              {result.text}
            </p>
          )}

          <p className="text-[10px] leading-relaxed text-slate-600">
            任何兼容 OpenAI Chat Completions 的接口都可以填（OpenAI、DeepSeek、自建网关等）。
            密钥只写入本机 userData 下的配置文件，不会随视频上传；不使用 AI 功能时字幕检索与导出完全离线可用。
          </p>
        </section>
      </div>
    </div>
  );
}
