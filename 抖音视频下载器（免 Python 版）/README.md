# 抖音视频下载器

一个面向 Windows 的桌面下载工具：粘贴公开抖音视频链接，解析页面实际播放地址并保存为 MP4。

## 当前版本

- 提供 Tkinter 图形界面，使用 5 个独立链接框（最多 5 个、每框一个、留空跳过），按顺序批量下载，并支持选择保存目录和显示下载进度。
- 使用 Playwright 驱动 Microsoft Edge 解析公开页面，再用 Requests 下载视频。
- 页面拆分音视频时，自动下载两条轨道并用 FFmpeg 合并，避免输出只有音频或只有画面。
- 已提供免 Python 的 Windows x64 单文件版本。
- 当前只下载公开可播放内容，不登录、不处理验证码、不绕过访问限制，也不去水印。

## 快速使用

没有 Python 的电脑：

1. 解压 `release/DouyinVideoDownloader-windows-x64.zip`。
2. 双击其中的 `DouyinVideoDownloader.exe`。
3. 在 1~5 号框各粘贴一个抖音链接（最多 5 个，留空自动跳过），选择目录后点击“开始下载”，程序会按顺序逐个下载。

目标电脑需要 Windows 10/11 x64 和 Microsoft Edge，不能正常公开访问抖音页面时可能无法解析。

开发电脑：

- 运行 `start_douyin_downloader.bat` 启动源码版。
- 运行 `./build_exe.ps1` 重新构建免 Python 版本。

## 文档

- [项目技术文档与任务规划](docs/PROJECT_SPEC.md)
- [免 Python 版使用说明](免Python版使用说明.md)
- [第三方组件声明](THIRD_PARTY_NOTICES.md)

## 许可与使用边界

请只下载自己拥有或已获得授权的内容，并遵守抖音平台规则、版权和隐私要求。本项目不承诺对失效、受限、需要登录或触发验证码的视频有效。
