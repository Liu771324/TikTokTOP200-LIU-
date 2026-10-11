# 第三方组件声明

本项目发布版内置 `ffmpeg.exe`，用于把页面返回的独立音频轨和视频轨封装为一个 MP4 文件。

## FFmpeg

该二进制显示为 FFmpeg 7.1 essentials build，启用了 GPL 配置。FFmpeg 项目主页和许可说明：

- https://ffmpeg.org/
- https://ffmpeg.org/legal.html

FFmpeg 的再分发、修改和源代码获取应遵守其随构建版本适用的 GPL 条款。可执行文件使用 `ffmpeg.exe -L` 查看许可信息。

## imageio-ffmpeg

本项目使用 `imageio-ffmpeg` Windows x64 wheel 中提供的 FFmpeg 二进制作为打包来源；该 Python 包项目地址：

- https://github.com/imageio/imageio-ffmpeg

其 BSD 2-Clause License：

```text
BSD 2-Clause License

Copyright (c) 2019-2025, imageio
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
