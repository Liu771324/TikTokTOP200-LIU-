# 第三方组件

工具箱使用以下独立组件，版本以同包 release-info.json、依赖锁和构建清单为准。第三方代码的许可由各组件自己的许可文件约束。

| 组件 | 版本 | 来源与许可位置 |
| --- | --- | --- |
| Python | 3.13.2 | https://www.python.org/；toolbox/runtime/licenses/python/LICENSE.txt；保留本机构建解释器 3.13.2 随附的完整原文（含其第三方声明） |
| proxy_tools | 0.1.0 | https://github.com/jtushman/proxy_tools；toolbox/runtime/licenses/proxy_tools/LICENSE.txt（上游实际正文为 BSD） |
| Node.js | 24.19.0 | https://nodejs.org/；toolbox/runtime/licenses/node/LICENSE |
| FFmpeg | 7.1 essentials GPL build | 原下载器第三方声明；toolbox/runtime/licenses/ffmpeg/COPYING.GPLv3 |
| Python Playwright | 1.58.0 | https://github.com/microsoft/playwright-python；随driver/package保留声明 |
| Node Playwright Core | 1.58.2 | https://github.com/microsoft/playwright；node_modules/playwright-core/LICENSE |
| ExcelJS | 4.4.0 | https://github.com/exceljs/exceljs；node_modules/exceljs/LICENSE |
| SheetJS Community Edition | 0.20.3 | https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz；node_modules/xlsx/LICENSE（Apache-2.0） |
| pywebview、pystray、Pillow、requests、openpyxl等 | 见requirements.lock.txt | 各Python包的dist-info/许可目录 |

Node依赖的传递组件保留在同一node_modules及其许可文件中。Python Playwright的协议脚本与Node端Playwright Core分别保留自己的版本；两者共享同一个Node可执行文件，不共享不同版本的协议脚本。

FFmpeg二进制沿用原下载器的imageio-ffmpeg来源，原声明随包保存。FFmpeg 7.1源码：https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz；构建提供方：https://www.gyan.dev/ffmpeg/builds/。当前开发构建不是公开发行验收结果；公开分发前须备齐与该GPL构建对应的完整源代码及构建材料，不能仅用一个项目主页链接替代。

Microsoft Edge和WebView2由微软提供。安装包的Evergreen引导安装器从微软官方下载，保留其签名；已安装WebView2时不重复安装。Inno Setup只用于构建安装包，构建机许可与编译器版本见windows/README.md。

## 补充许可来源

Python 许可从本机已验证 `python --version` 为 3.13.2 的官方 Windows 解释器同目录 LICENSE.txt 原样复制，仓库路径 windows/licenses/python/LICENSE.txt，SHA256：`62bec384df47b0328307db41455ff6ea2559e5546b394ac69148561b21703120`。

proxy_tools 0.1.0 的安装元数据与官方 setup.py 标记 MIT，但官方 LICENSE.txt 实际为 BSD 文本。工具箱原样保留该文件及其中 Armin Ronacher / Jonathan Tushman 版权声明，不生成另一份 MIT 正文。固定来源：https://raw.githubusercontent.com/jtushman/proxy_tools/db43f1e35d4f90a65c5a4d56d9e9af88212ec6e6/LICENSE.txt；同 commit 的 setup.py 为 0.1.0，proxy_tools/__init__.py 与本机构建环境已安装 0.1.0 源码一致（忽略换行）。仓库路径 windows/licenses/proxy_tools/LICENSE.txt，SHA256：`a428fb8a2e762af3eb0a6edbbb88e9b42ccfee80fd9b423958bcacf9b9abbfe4`。该上游元数据冲突保留说明，公开发行前继续核对；FFmpeg 对应完整源码及构建材料仍为公开分发前限制。
