const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('topiccut', {
  pickVideo: () => ipcRenderer.invoke('dialog:pickVideo'),
  pickSubtitle: () => ipcRenderer.invoke('dialog:pickSubtitle'),
  detectFfmpeg: () => ipcRenderer.invoke('ffmpeg:detect'),
  probe: (p) => ipcRenderer.invoke('ffmpeg:probe', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  exportClip: (payload) => ipcRenderer.invoke('clip:export', payload),
  reveal: (p) => ipcRenderer.invoke('app:reveal', p),
  probeSubtitles: (videoPath) => ipcRenderer.invoke('subtitle:probe', videoPath),
  videoSource: (p) => ipcRenderer.invoke('video:source', p),
  extractEmbedded: (payload) => ipcRenderer.invoke('subtitle:extractEmbedded', payload),
  detectWhisper: () => ipcRenderer.invoke('whisper:detect'),
  pickWhisperBinary: () => ipcRenderer.invoke('whisper:pickBinary'),
  pickWhisperModel: () => ipcRenderer.invoke('whisper:pickModel'),
  transcribe: (payload) => ipcRenderer.invoke('whisper:transcribe', payload),
  cancelTranscribe: (taskId) => ipcRenderer.invoke('whisper:cancel', taskId),
  onWhisperProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('whisper:progress', listener);
    return () => ipcRenderer.removeListener('whisper:progress', listener);
  },
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  saveAiConfig: (patch) => ipcRenderer.invoke('ai:setConfig', patch),
  testAi: () => ipcRenderer.invoke('ai:test'),
  aiAnalyzeVideo: (payload) => ipcRenderer.invoke('ai:analyzeVideo', payload),
  aiAnalyzeClip: (payload) => ipcRenderer.invoke('ai:analyzeClip', payload),
  aiQuestionTerms: (payload) => ipcRenderer.invoke('ai:questionTerms', payload),
  aiAnswer: (payload) => ipcRenderer.invoke('ai:answer', payload),
  aiExpandTopic: (payload) => ipcRenderer.invoke('ai:expandTopic', payload),
  cancelAi: (taskId) => ipcRenderer.invoke('ai:cancel', taskId),
  onAiProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('ai:progress', listener);
    return () => ipcRenderer.removeListener('ai:progress', listener);
  },
  demoLoad: () => ipcRenderer.invoke('demo:load'),
  onExportProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
});
