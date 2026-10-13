# 第三方组件

工具箱使用以下独立组件，版本以同包 release-info.json、依赖锁和构建清单为准。第三方代码的许可由各组件自己的许可文件约束。

| 组件 | 版本 | 来源与许可位置 |
| --- | --- | --- |
| Python | 3.13.2 | https://www.python.org/；随冻结运行库保留 Python 许可 |
| Node.js | 24.19.0 | https://nodejs.org/；toolbox/runtime/licenses/node/LICENSE |
| FFmpeg | 7.1 essentials GPL build | 原下载器第三方声明；toolbox/runtime/licenses/ffmpeg/COPYING.GPLv3 |
| Python Playwright | 1.58.0 | https://github.com/microsoft/playwright-python；随driver/package保留声明 |
| Node Playwright Core | 1.58.2 | https://github.com/microsoft/playwright；node_modules/playwright-core/LICENSE |
| ExcelJS | 4.4.0 | https://github.com/exceljs/exceljs；node_modules/exceljs/LICENSE |
| pywebview、pystray、Pillow、requests、openpyxl等 | 见requirements.lock.txt | 各Python包的dist-info/许可目录 |

Node依赖的传递组件保留在同一node_modules及其许可文件中。Python Playwright的协议脚本与Node端Playwright Core分别保留自己的版本；两者共享同一个Node可执行文件，不共享不同版本的协议脚本。

FFmpeg二进制沿用原下载器的imageio-ffmpeg来源，原声明随包保存。FFmpeg 7.1源码：https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz；构建提供方：https://www.gyan.dev/ffmpeg/builds/。当前开发构建不是公开发行验收结果；公开分发前须备齐与该GPL构建对应的完整源代码及构建材料，不能仅用一个项目主页链接替代。

Microsoft Edge和WebView2由微软提供。安装包的Evergreen引导安装器从微软官方下载，保留其签名；已安装WebView2时不重复安装。Inno Setup只用于构建安装包，构建机许可与编译器版本见windows/README.md。
