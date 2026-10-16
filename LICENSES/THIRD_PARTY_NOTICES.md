# 第三方组件清单（TopicCut 1.5.0 Windows 安装包）

本表按**实际随包内容**整理，不声称全部组件为 MIT。

| 组件 | 版本 | 随包形式 | 许可证 | 位置 |
| --- | --- | --- | --- | --- |
| TopicCut 自身代码 | 1.5.0 | 编译进 `resources/app.asar` | MIT | 仓库根 `LICENSE` |
| Electron | 33.4.11 | 运行时主体 | MIT（含 Chromium/Node 等第三方清单） | `resources/LICENSE`、`resources/LICENSES.chromium.html`、`LICENSES/ELECTRON-NOTICE.txt` |
| FFmpeg | 6.1.1-essentials_build (gyan.dev) | `resources/runtime/ffmpeg/ffmpeg.exe` | **GPL-3.0** | `LICENSES/FFMPEG-GPL-3.0.txt` + `FFMPEG-NOTICE.txt`（含源码要约）+ `FFMPEG-BUILD-CONFIG.txt` |
| whisper.cpp CLI 与 ggml 运行时 | 1.9.5 | `resources/runtime/whisper/`（13 个文件，约 12 MB） | MIT（上游） | `LICENSES/WHISPER-CPP-NOTICE.txt` |
| Whisper 模型 ggml-*.bin | — | **不随包** | 模型权重同为 MIT | 需用户自行放置，见 README |
| React / React DOM | 18.3.1 | 打包进前端 bundle | MIT | 源码级许可声明见上游 |
| 构建期工具（vite / typescript / tailwind / electron-builder 等） | — | 不随包分发 | 各自许可 | 仅开发机使用 |

## 明确未包含的组件

`llama.dll`、`parakeet.dll`、`SDL2.dll`、`whisper-server.exe`、`whisper-stream.exe`、
`test-*.exe`、`ffprobe.exe`、`ffplay.exe` —— TopicCut 不使用，故不随包分发。

## 发布前必须补做的一项

whisper.cpp 官方 Windows 预编译 zip 内不含 LICENSE 文件，本次打包环境无法联网取原文，
因此 `LICENSES/WHISPER-CPP-NOTICE.txt` 只有来源说明而没有逐字许可正文。
**对外发布前需从上游仓库补入 LICENSE 原文。**
