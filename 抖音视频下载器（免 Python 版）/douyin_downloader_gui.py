"""Simple Douyin video downloader with a Windows-friendly Tkinter GUI.

The program only downloads publicly playable videos. It does not log in,
solve CAPTCHAs, bypass access controls, or remove watermarks.
"""

from __future__ import annotations

import html
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import requests
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36"
)
DOUYIN_HOST_SUFFIXES = ("douyin.com", "iesdouyin.com")
URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
VIDEO_ID_PATTERN = re.compile(r"/(?:video|note|slides)/(\d+)", re.IGNORECASE)


def _is_douyin_host(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower().rstrip(".")
    return any(
        hostname == suffix or hostname.endswith(f".{suffix}")
        for suffix in DOUYIN_HOST_SUFFIXES
    )


def extract_input_urls(text: str) -> tuple[list[str], list[str]]:
    """Extract every Douyin URL from one or more lines / share messages.

    Returns ``(douyin_urls, rejected_urls)`` where ``douyin_urls`` keeps input
    order with duplicates removed, and ``rejected_urls`` lists non-Douyin URLs
    so the caller can report them instead of silently dropping them.
    """
    accepted: list[str] = []
    rejected: list[str] = []
    seen: set[str] = set()
    for match in URL_PATTERN.finditer(text):
        url = match.group(0).rstrip("，。；、）)]}>")
        if _is_douyin_host(url):
            if url not in seen:
                seen.add(url)
                accepted.append(url)
        elif url not in rejected:
            rejected.append(url)

    if not accepted:
        if rejected:
            raise ValueError("目前只支持 douyin.com 或 iesdouyin.com 链接")
        raise ValueError("没有找到链接，请粘贴抖音分享链接或完整分享文案（可一次粘贴多个）")
    return accepted, rejected


def safe_filename(name: str, fallback: str) -> str:
    """Make a Windows-safe filename without changing the extension."""
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", name).strip().strip(".")
    name = re.sub(r"\s+", " ", name)
    return (name or fallback)[:100]


def is_public_video_url(value: str) -> bool:
    """Keep real Douyin media URLs and ignore player test assets."""
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    path_and_query = f"{parsed.path}?{parsed.query}".lower()
    return "douyinvod.com" in host or "/aweme/v1/play" in path_and_query


def media_kind(value: str, content_type: str = "") -> str | None:
    """Classify a Douyin media URL as an audio or video track."""
    lowered_url = value.lower()
    lowered_type = content_type.lower()
    if (
        "/media-audio-" in lowered_url
        or "mime_type=audio" in lowered_url
        or lowered_type.startswith("audio/")
    ):
        return "audio"
    if (
        "/media-video-" in lowered_url
        or "mime_type=video" in lowered_url
        or lowered_type.startswith("video/")
    ):
        return "video"
    return None


def unique_output_path(directory: Path, stem: str) -> Path:
    candidate = directory / f"{stem}.mp4"
    counter = 1
    while candidate.exists():
        candidate = directory / f"{stem}_{counter}.mp4"
        counter += 1
    return candidate


def extract_urls_from_html(source: str) -> list[str]:
    """Best-effort fallback for public media URLs embedded in page HTML."""
    decoded = html.unescape(source)
    decoded = decoded.replace("\\/", "/").replace("\\u0026", "&")
    candidates = URL_PATTERN.findall(decoded)
    result: list[str] = []
    for candidate in candidates:
        candidate = candidate.rstrip("\\")
        lowered = candidate.lower()
        if is_public_video_url(candidate) and (
            "video" in lowered or "mime_type=video" in lowered or ".mp4" in lowered
        ):
            if candidate not in result:
                result.append(candidate)
    return result


def extract_media_with_browser(
    page_url: str,
    log: Callable[[str], None],
) -> tuple[str, str, str | None, str | None]:
    """Open the page in Playwright and read the actual public video source."""
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError(
            "缺少 Playwright，请执行：python -m pip install playwright requests"
        ) from exc

    with sync_playwright() as playwright:
        browser = None
        try:
            try:
                # The packaged app uses the Edge installation that ships with
                # Windows, so the target computer does not need Python or a
                # separately downloaded Playwright browser.
                browser = playwright.chromium.launch(channel="msedge", headless=True)
            except PlaywrightError as edge_error:
                try:
                    browser = playwright.chromium.launch(headless=True)
                except PlaywrightError as bundled_error:
                    raise RuntimeError(
                        "未找到可用的 Microsoft Edge 浏览器，请先安装或更新 Edge"
                    ) from bundled_error
            page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1440, "height": 900})
            network_media_urls: dict[str, list[str]] = {"video": [], "audio": []}

            def remember_media_response(response) -> None:
                response_url = response.url
                content_type = (response.headers.get("content-type") or "").lower()
                kind = media_kind(response_url, content_type)
                if is_public_video_url(response_url) and kind:
                    if response_url not in network_media_urls[kind]:
                        network_media_urls[kind].append(response_url)

            page.on("response", remember_media_response)
            log("正在打开抖音页面…")
            page.goto(page_url, wait_until="domcontentloaded", timeout=45_000)

            media_urls: list[str] = []
            for _ in range(15):
                try:
                    media_urls = page.eval_on_selector_all(
                        "video, video source",
                        r"""
                        elements => elements.flatMap(element => [
                            element.getAttribute('src') || '',
                            element.getAttribute('data-src') || '',
                            element.getAttribute('data-url') || '',
                            element.src || '',
                            element.currentSrc || ''
                        ]).filter(url => /^https?:/i.test(url))
                          .filter(url => /douyinvod\.com|\/aweme\/v1\/play/i.test(url))
                        """,
                    )
                except PlaywrightError as exc:
                    if "execution context was destroyed" not in str(exc).lower():
                        raise
                    # 抖音页面可能在首次打开后发生一次二次导航；不要把这个
                    # 短暂的上下文失效当成解析失败，等下一轮重新查询。
                    page.wait_for_timeout(500)
                    continue
                for candidate in media_urls:
                    kind = media_kind(candidate) or "video"
                    if candidate not in network_media_urls[kind]:
                        network_media_urls[kind].append(candidate)
                separate_video = any(
                    "/media-video-" in candidate.lower() for candidate in network_media_urls["video"]
                )
                if network_media_urls["video"] and (
                    network_media_urls["audio"] or not separate_video
                ):
                    break
                page.wait_for_timeout(1_000)

            title = ""
            heading = page.locator("h1").first
            if heading.count():
                title = (heading.text_content(timeout=3_000) or "").strip()
            if not title:
                title = (page.title() or "").replace(" - 抖音", "").strip()

            final_url = page.url or page_url
            if not network_media_urls["video"]:
                log("页面未直接显示播放器，尝试读取页面公开数据…")
                network_media_urls["video"] = extract_urls_from_html(page.content())

            if not network_media_urls["video"]:
                raise RuntimeError("未找到公开视频地址，可能是视频失效、受限或触发了验证码")
            return (
                final_url,
                title,
                network_media_urls["video"][0],
                network_media_urls["audio"][0] if network_media_urls["audio"] else None,
            )
        except PlaywrightTimeoutError as exc:
            raise RuntimeError("打开抖音页面超时，请检查网络后重试") from exc
        finally:
            if browser is not None:
                browser.close()


def extract_media_with_requests(page_url: str) -> tuple[str, str, str | None, str | None]:
    """Fallback extractor for environments where a browser cannot launch."""
    response = requests.get(
        page_url,
        headers={"User-Agent": USER_AGENT},
        allow_redirects=True,
        timeout=30,
    )
    response.raise_for_status()
    media_urls = extract_urls_from_html(response.text)
    if not media_urls:
        raise RuntimeError("无法从页面源码找到公开视频地址，请安装 Playwright 后重试")
    title = ""
    title_match = re.search(r"<title[^>]*>(.*?)</title>", response.text, re.IGNORECASE | re.DOTALL)
    if title_match:
        title = re.sub(r"\s+", " ", html.unescape(title_match.group(1))).strip()
        title = title.replace(" - 抖音", "").strip()
    return response.url, title, media_urls[0], None


def download_media(
    media_url: str,
    page_url: str,
    output_path: Path,
    progress: Callable[[int | None, int], None],
) -> None:
    """Download to a .part file, then atomically move it into place."""
    temporary_path = output_path.with_suffix(output_path.suffix + ".part")
    headers = {"User-Agent": USER_AGENT, "Referer": page_url}
    try:
        with requests.get(
            media_url,
            headers=headers,
            stream=True,
            timeout=(20, 120),
        ) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0) or None
            written = 0
            with temporary_path.open("wb") as file:
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    if not chunk:
                        continue
                    file.write(chunk)
                    written += len(chunk)
                    progress(total, written)
        if written == 0:
            raise RuntimeError("下载结果为空")
        os.replace(temporary_path, output_path)
    except Exception:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def find_ffmpeg() -> Path:
    """Find the bundled FFmpeg binary or a developer-installed one."""
    if getattr(sys, "frozen", False):
        bundled_path = Path(getattr(sys, "_MEIPASS", "")) / "ffmpeg.exe"
    else:
        bundled_path = Path(__file__).resolve().with_name("ffmpeg.exe")
    if bundled_path.is_file():
        return bundled_path

    system_path = shutil.which("ffmpeg")
    if system_path:
        return Path(system_path)
    raise RuntimeError("需要 FFmpeg 合并音视频轨道，请将 ffmpeg.exe 放在程序目录或加入 PATH")


def mux_media(
    video_path: Path,
    audio_path: Path,
    output_path: Path,
) -> None:
    """Mux separate video and audio tracks without re-encoding."""
    ffmpeg_path = find_ffmpeg()
    temporary_path = output_path.with_suffix(output_path.suffix + ".part")
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-shortest",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        str(temporary_path),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            check=False,
        )
        if result.returncode != 0:
            detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "未知错误"
            raise RuntimeError(f"音视频合并失败：{detail}")
        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            raise RuntimeError("音视频合并结果为空")
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def download_from_link(
    page_url: str,
    output_directory: Path,
    log: Callable[[str], None],
    progress: Callable[[int | None, int], None],
) -> Path:
    """Resolve and download a single, already-validated Douyin URL."""
    output_directory.mkdir(parents=True, exist_ok=True)

    try:
        final_url, title, video_url, audio_url = extract_media_with_browser(page_url, log)
    except Exception as browser_error:
        log(f"浏览器解析失败：{browser_error}")
        log("尝试使用页面源码解析…")
        final_url, title, video_url, audio_url = extract_media_with_requests(page_url)

    video_id_match = VIDEO_ID_PATTERN.search(final_url) or VIDEO_ID_PATTERN.search(page_url)
    video_id = video_id_match.group(1) if video_id_match else str(int(time.time()))
    stem = safe_filename(title, f"douyin_{video_id}")
    output_path = unique_output_path(output_directory, stem)
    log(f"已找到视频：{title or video_id}")
    log(f"正在下载到：{output_path}")
    if audio_url:
        log("检测到独立音频和视频轨道，正在下载并合并…")
        with tempfile.TemporaryDirectory(prefix="douyin_tracks_") as temporary_directory:
            temporary_directory_path = Path(temporary_directory)
            video_track_path = temporary_directory_path / "video.mp4"
            audio_track_path = temporary_directory_path / "audio.mp4"
            download_media(video_url, final_url, video_track_path, progress)
            download_media(audio_url, final_url, audio_track_path, progress)
            mux_media(video_track_path, audio_track_path, output_path)
    else:
        download_media(video_url, final_url, output_path, progress)
    return output_path


class DownloaderApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("抖音视频下载器")
        self.root.geometry("760x680")
        self.root.minsize(680, 600)

        self.max_links = 5
        default_directory = Path.cwd() / "douyin_downloads"
        self.url_vars = [tk.StringVar() for _ in range(self.max_links)]
        self.directory_var = tk.StringVar(value=str(default_directory))
        self.status_var = tk.StringVar(value="就绪")
        self.count_var = tk.StringVar(value=f"请在下方粘贴链接，最多 {self.max_links} 个")
        self.progress_var = tk.DoubleVar(value=0)

        self._build_ui()

    def _build_ui(self) -> None:
        root = self.root
        root.columnconfigure(0, weight=1)
        root.rowconfigure(0, weight=1)

        main = ttk.Frame(root, padding=16)
        main.grid(row=0, column=0, sticky="nsew")
        main.columnconfigure(0, weight=1)
        main.columnconfigure(1, weight=1)
        main.rowconfigure(5, weight=1)

        ttk.Label(main, text="抖音视频下载器", font=("Microsoft YaHei UI", 16, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 12)
        )

        ttk.Label(
            main,
            text=(
                f"抖音链接：每个框粘贴一个，最多 {self.max_links} 个，"
                f"按 1→{self.max_links} 顺序下载，留空的框自动跳过"
            ),
        ).grid(row=1, column=0, columnspan=3, sticky="w")

        links_frame = ttk.Frame(main)
        links_frame.grid(row=2, column=0, columnspan=3, sticky="ew", pady=(6, 0))
        links_frame.columnconfigure(1, weight=1)
        self.url_entries: list[ttk.Entry] = []
        for row_index in range(self.max_links):
            ttk.Label(links_frame, text=f"{row_index + 1}.").grid(
                row=row_index, column=0, sticky="w", padx=(0, 6), pady=2
            )
            entry = ttk.Entry(links_frame, textvariable=self.url_vars[row_index])
            entry.grid(row=row_index, column=1, sticky="ew", pady=2)
            entry.bind("<KeyRelease>", lambda _event: self._update_link_count())
            self.url_entries.append(entry)
            ttk.Button(
                links_frame,
                text="粘贴",
                command=lambda idx=row_index: self._paste_into_row(idx),
            ).grid(row=row_index, column=2, padx=(8, 0), pady=2)

        count_row = ttk.Frame(main)
        count_row.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(6, 0))
        ttk.Label(count_row, textvariable=self.count_var, foreground="#666666").pack(side=tk.LEFT)
        ttk.Button(count_row, text="清空全部", command=self._clear_urls).pack(side=tk.RIGHT)

        ttk.Label(main, text="保存目录：").grid(row=4, column=0, sticky="w", padx=(0, 8), pady=(10, 0))
        ttk.Entry(main, textvariable=self.directory_var).grid(row=4, column=1, sticky="ew", pady=(10, 0))
        ttk.Button(main, text="浏览…", command=self._choose_directory).grid(
            row=4, column=2, padx=(8, 0), pady=(10, 0)
        )

        self.log_box = scrolledtext.ScrolledText(main, height=14, state="disabled", wrap=tk.WORD)
        self.log_box.grid(row=5, column=0, columnspan=3, sticky="nsew", pady=(12, 10))

        self.progress = ttk.Progressbar(main, variable=self.progress_var, maximum=100)
        self.progress.grid(row=6, column=0, columnspan=3, sticky="ew")
        ttk.Label(main, textvariable=self.status_var).grid(row=7, column=0, columnspan=2, sticky="w", pady=(8, 0))

        buttons = ttk.Frame(main)
        buttons.grid(row=7, column=2, sticky="e", pady=(8, 0))
        self.download_button = ttk.Button(buttons, text="开始下载", command=self._start_download)
        self.download_button.pack(side=tk.LEFT)
        ttk.Button(buttons, text="打开目录", command=self._open_directory).pack(side=tk.LEFT, padx=(8, 0))

        self.url_entries[0].focus_set()

    def _paste_into_row(self, row_index: int) -> None:
        """Paste the clipboard into one specific row (one link per row)."""
        try:
            clipboard = self.root.clipboard_get()
        except tk.TclError:
            messagebox.showinfo("提示", "剪贴板中没有可读取的文本")
            return
        self.url_vars[row_index].set(clipboard.strip())
        self._update_link_count()
        # Move focus to the next row so links can be pasted one after another.
        if row_index + 1 < self.max_links:
            self.url_entries[row_index + 1].focus_set()

    def _clear_urls(self) -> None:
        for var in self.url_vars:
            var.set("")
        self._update_link_count()
        self.url_entries[0].focus_set()

    def _collect_rows(self) -> tuple[list[str], list[int], list[int]]:
        """Read the five rows into ordered URLs.

        Returns ``(valid_urls, invalid_rows, multi_links_rows)``:
        empty rows are skipped, duplicates are removed while keeping order,
        and a row that somehow contains several links only uses its first.
        """
        valid_urls: list[str] = []
        invalid_rows: list[int] = []
        multi_rows: list[int] = []
        seen: set[str] = set()
        for row_index, var in enumerate(self.url_vars, start=1):
            text = var.get().strip()
            if not text:
                continue
            try:
                accepted, _rejected = extract_input_urls(text)
            except ValueError:
                invalid_rows.append(row_index)
                continue
            if len(accepted) > 1:
                multi_rows.append(row_index)
            url = accepted[0]
            if url not in seen:
                seen.add(url)
                valid_urls.append(url)
        return valid_urls, invalid_rows, multi_rows

    def _update_link_count(self) -> None:
        valid_urls, invalid_rows, _multi_rows = self._collect_rows()
        if invalid_rows:
            self.count_var.set(
                f"第 {'、'.join(map(str, invalid_rows))} 行不是有效的抖音链接"
            )
            return
        if valid_urls:
            self.count_var.set(
                f"已识别 {len(valid_urls)}/{self.max_links} 个链接，将按顺序下载"
            )
        else:
            self.count_var.set(f"请粘贴链接，最多 {self.max_links} 个")

    def _choose_directory(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.directory_var.get())
        if selected:
            self.directory_var.set(selected)

    def _open_directory(self) -> None:
        directory = Path(self.directory_var.get()).expanduser()
        directory.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(directory)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(directory)])
        else:
            subprocess.Popen(["xdg-open", str(directory)])

    def _append_log(self, message: str) -> None:
        self.log_box.configure(state="normal")
        self.log_box.insert(tk.END, message + "\n")
        self.log_box.see(tk.END)
        self.log_box.configure(state="disabled")

    def _start_download(self) -> None:
        urls, invalid_rows, multi_rows = self._collect_rows()
        if invalid_rows:
            messagebox.showwarning(
                "链接无效",
                f"第 {'、'.join(map(str, invalid_rows))} 行不是有效的抖音链接，请修改或清空该行",
            )
            return
        if not urls:
            messagebox.showwarning(
                "缺少链接",
                f"请至少在一个框中粘贴抖音链接（最多 {self.max_links} 个）",
            )
            return

        self.download_button.configure(state="disabled")
        self.progress_var.set(0)
        self.status_var.set(f"准备下载，共 {len(urls)} 个…")
        self._append_log(
            f"===== 开始批量下载，共 {len(urls)} 个链接，按 1→{self.max_links} 顺序处理 ====="
        )
        for row_index in multi_rows:
            self._append_log(f"第 {row_index} 行包含多个链接，仅取该行第一个")
        thread = threading.Thread(target=self._download_worker, args=(urls,), daemon=True)
        thread.start()

    def _download_worker(self, urls: list[str]) -> None:
        output_directory = Path(self.directory_var.get()).expanduser()
        total = len(urls)
        succeeded: list[Path] = []
        failed: list[tuple[int, str, str]] = []

        for index, url in enumerate(urls, start=1):
            self.root.after(0, self._begin_item, index, total)
            self.root.after(
                0,
                self._append_log,
                f"————— 第 {index}/{total} 个 —————\n链接：{url}",
            )
            try:
                output_path = download_from_link(
                    url,
                    output_directory,
                    lambda message: self.root.after(0, self._append_log, message),
                    lambda item_total, item_written: self.root.after(
                        0, self._update_progress, index, total, item_total, item_written
                    ),
                )
            except Exception as exc:  # one bad link must not abort the queue
                failed.append((index, url, str(exc)))
                self.root.after(0, self._append_log, f"第 {index} 个失败：{exc}")
            else:
                succeeded.append(output_path)
                self.root.after(0, self._append_log, f"第 {index} 个完成：{output_path}")

        self.root.after(0, self._batch_finished, succeeded, failed)

    def _begin_item(self, index: int, total: int) -> None:
        self.progress_var.set(0)
        self.status_var.set(f"正在解析第 {index}/{total} 个…")

    def _update_progress(
        self,
        index: int,
        total: int,
        total_bytes: int | None,
        written: int,
    ) -> None:
        if total_bytes:
            percent = written / total_bytes * 100
            self.progress_var.set(percent)
            self.status_var.set(f"第 {index}/{total} 个下载中… {percent:.1f}%")
        else:
            self.status_var.set(
                f"第 {index}/{total} 个下载中… {written / 1024 / 1024:.1f} MB"
            )

    def _batch_finished(
        self,
        succeeded: list[Path],
        failed: list[tuple[int, str, str]],
    ) -> None:
        self.download_button.configure(state="normal")
        success_count = len(succeeded)
        failure_count = len(failed)

        if failure_count == 0:
            self.progress_var.set(100)
            self.status_var.set(f"全部完成，共成功 {success_count} 个")
            self._append_log(f"===== 全部完成：成功 {success_count} 个 =====")
            messagebox.showinfo("下载完成", f"全部 {success_count} 个视频已下载完成")
            return

        if success_count:
            self.status_var.set(f"完成 {success_count} 个，失败 {failure_count} 个")
            detail = "\n".join(
                f"第 {index} 个失败：{message}" for index, _url, message in failed
            )
            self._append_log(
                f"===== 结束：成功 {success_count} 个，失败 {failure_count} 个 ====="
            )
            messagebox.showwarning(
                "部分完成",
                f"成功 {success_count} 个，失败 {failure_count} 个。\n\n{detail}",
            )
        else:
            self.progress_var.set(0)
            self.status_var.set("全部失败")
            detail = "\n".join(
                f"第 {index} 个失败：{message}" for index, _url, message in failed
            )
            self._append_log("===== 全部失败，请查看上方日志 =====")
            messagebox.showerror("下载失败", f"{failure_count} 个链接均未下载成功：\n\n{detail}")


def main() -> None:
    root = tk.Tk()
    DownloaderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
