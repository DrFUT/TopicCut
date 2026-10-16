import type { BridgeApi } from '../types/index.ts';

export function getBridge(): BridgeApi | null {
  return typeof window !== 'undefined' && window.topiccut ? window.topiccut : null;
}

export function requireBridge(): BridgeApi {
  const bridge = getBridge();
  if (!bridge) throw new Error('桌面能力未就绪：请在 Electron 中运行（npm run dev），浏览器预览模式无法访问本地文件与 FFmpeg。');
  return bridge;
}
