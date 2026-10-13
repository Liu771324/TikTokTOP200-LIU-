"""Douyin public-video download core, independent of desktop UI.

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
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import requests


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36"
)
DOUYIN_HOST_SUFFIXES = ("douyin.com", "iesdouyin.com")
URL_PATTERN = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
VIDEO_ID_PATTERN = re.compile(r"/(?:video|note|slides)/(\d+)", re.IGNORECASE)


class DownloadCancelled(RuntimeError):
    """The caller cancelled; this must never trigger a parser fallback."""

    code = "CANCELLED"


class DownloadNetworkError(RuntimeError):
    """A UI-safe network error without signed URLs from requests exceptions."""

    code = "NETWORK_ERROR"

    def __init__(self, error: requests.RequestException):
        self.error_type = type(error).__name__
        self.status_code = error.response.status_code if error.response is not None else None
        super().__init__(f"视频网络请求失败（{self.error_type}），请检查网络后重试")


@dataclass(frozen=True)
class DownloadContext:
    output_directory: Path
    scratch_directory: Path
    ffmpeg_path: Path | None = None
    process_factory: Callable | None = None


@dataclass(frozen=True)
class DownloadCandidate:
    path: Path
    title: str
    source_url: str


def _never_cancel() -> bool:
    return False


def _check_cancel(should_cancel: Callable[[], bool]) -> None:
    if should_cancel():
        raise DownloadCancelled("下载已取消")


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
    while candidate.exists() or candidate.with_suffix(".mp4.part").exists():
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
    *,
    should_cancel: Callable[[], bool] = _never_cancel,
) -> tuple[str, str, str | None, str | None]:
    """Open the page in Playwright and read the actual public video source."""
    _check_cancel(should_cancel)
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
                _check_cancel(should_cancel)
                try:
                    browser = playwright.chromium.launch(headless=True)
                except PlaywrightError as bundled_error:
                    raise RuntimeError(
                        "未找到可用的 Microsoft Edge 浏览器，请先安装或更新 Edge"
                    ) from bundled_error
            page = browser.new_page(user_agent=USER_AGENT, viewport={"width": 1440, "height": 900})
            _check_cancel(should_cancel)
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
            _check_cancel(should_cancel)

            media_urls: list[str] = []
            for _ in range(15):
                _check_cancel(should_cancel)
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
            _check_cancel(should_cancel)
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


def extract_media_with_requests(
    page_url: str, *, should_cancel: Callable[[], bool] = _never_cancel,
) -> tuple[str, str, str | None, str | None]:
    """Fallback extractor for environments where a browser cannot launch."""
    _check_cancel(should_cancel)
    with requests.get(
        page_url,
        headers={"User-Agent": USER_AGENT},
        allow_redirects=True,
        timeout=30,
    ) as response:
        response.raise_for_status()
        _check_cancel(should_cancel)
        source = response.text
        final_url = response.url
    media_urls = extract_urls_from_html(source)
    if not media_urls:
        raise RuntimeError("无法从页面源码找到公开视频地址，请安装 Playwright 后重试")
    title = ""
    title_match = re.search(r"<title[^>]*>(.*?)</title>", source, re.IGNORECASE | re.DOTALL)
    if title_match:
        title = re.sub(r"\s+", " ", html.unescape(title_match.group(1))).strip()
        title = title.replace(" - 抖音", "").strip()
    _check_cancel(should_cancel)
    return final_url, title, media_urls[0], None


def _publish_without_overwrite(temporary_path: Path, output_path: Path) -> None:
    # Windows rename fails if the destination exists, unlike os.replace.
    if os.name == "nt":
        os.rename(temporary_path, output_path)
    else:
        os.link(temporary_path, output_path)
        temporary_path.unlink()


def download_media(
    media_url: str,
    page_url: str,
    output_path: Path,
    progress: Callable[[int | None, int], None],
    *,
    should_cancel: Callable[[], bool] = _never_cancel,
) -> None:
    """Download to a .part file, then atomically move it into place."""
    temporary_path = output_path.with_suffix(output_path.suffix + ".part")
    headers = {"User-Agent": USER_AGENT, "Referer": page_url}
    created = False
    try:
        _check_cancel(should_cancel)
        with requests.get(
            media_url,
            headers=headers,
            stream=True,
            timeout=(20, 120),
        ) as response:
            response.raise_for_status()
            _check_cancel(should_cancel)
            total = int(response.headers.get("content-length") or 0) or None
            written = 0
            with temporary_path.open("xb") as file:
                created = True
                for chunk in response.iter_content(chunk_size=1024 * 256):
                    _check_cancel(should_cancel)
                    if not chunk:
                        continue
                    file.write(chunk)
                    written += len(chunk)
                    progress(total, written)
            if total and response.headers.get("content-encoding", "identity") == "identity" and written != total:
                raise RuntimeError("下载结果不完整")
        if written == 0:
            raise RuntimeError("下载结果为空")
        _check_cancel(should_cancel)
        _publish_without_overwrite(temporary_path, output_path)
    except Exception:
        try:
            if created:
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
    *,
    ffmpeg_path: Path | None = None,
    should_cancel: Callable[[], bool] = _never_cancel,
    process_factory: Callable | None = None,
) -> None:
    """Mux separate video and audio tracks without re-encoding."""
    _check_cancel(should_cancel)
    ffmpeg_path = ffmpeg_path if ffmpeg_path is not None else find_ffmpeg()
    temporary_path = output_path.with_suffix(output_path.suffix + ".part")
    # FFmpeg may overwrite this placeholder only after this call owns it.
    # Keep reservation outside the cleanup try so another call's part is safe.
    with temporary_path.open("xb"):
        pass
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
        # A file avoids blocking on a full stderr pipe while polling cancellation.
        with tempfile.TemporaryFile(dir=output_path.parent) as stderr:
            options = dict(
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=stderr,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            job = None
            if process_factory is None:
                process = subprocess.Popen(command, **options)
            else:
                process, job = process_factory(command, **options)
            try:
                deadline = time.monotonic() + 180
                while process.poll() is None:
                    _check_cancel(should_cancel)
                    if time.monotonic() >= deadline:
                        raise RuntimeError("音视频合并超时")
                    try:
                        process.wait(timeout=0.1)
                    except subprocess.TimeoutExpired:
                        pass
                _check_cancel(should_cancel)
                if process.returncode != 0:
                    stderr.seek(0, os.SEEK_END)
                    stderr.seek(max(0, stderr.tell() - 4096))
                    detail = stderr.read().decode("utf-8", errors="replace").strip()
                    detail = detail.splitlines()[-1] if detail else "未知错误"
                    raise RuntimeError(f"音视频合并失败：{detail}")
            finally:
                # Reap before closing stderr or deleting output on Windows.
                if job is not None:
                    job.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                else:
                    process.wait()
        if not temporary_path.is_file() or temporary_path.stat().st_size == 0:
            raise RuntimeError("音视频合并结果为空")
        _publish_without_overwrite(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def download_from_link(
    page_url: str,
    output_directory: Path,
    log: Callable[[str], None],
    progress: Callable[[int | None, int], None],
) -> Path:
    """Resolve and download a single, already-validated Douyin URL."""
    candidate = download_one(
        page_url, DownloadContext(output_directory, output_directory),
        lambda event: progress(event["total_bytes"], event["downloaded_bytes"])
        if event["phase"] in {"downloading_video", "downloading_audio"} else None,
        log, _never_cancel,
    )
    return candidate.path


def download_one(
    source: str,
    context: DownloadContext,
    on_progress: Callable[[dict], None],
    on_log: Callable[[str], None],
    should_cancel: Callable[[], bool] = _never_cancel,
) -> DownloadCandidate:
    """Create one candidate. The host owns registration and persistent state.

    Progress events have phase, downloaded_bytes and total_bytes (possibly None).
    No temporary media URLs are returned as persistent source metadata.
    """
    if not _is_douyin_host(source) or urlparse(source).scheme not in {"http", "https"}:
        raise ValueError("目前只支持 douyin.com 或 iesdouyin.com 链接")
    _check_cancel(should_cancel)
    page_url = source
    output_directory = Path(context.output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    scratch_directory = Path(context.scratch_directory)
    scratch_directory.mkdir(parents=True, exist_ok=True)

    def report(phase: str, total: int | None = None, written: int = 0) -> None:
        on_progress({"phase": phase, "downloaded_bytes": written, "total_bytes": total})

    report("resolving")
    try:
        final_url, title, video_url, audio_url = extract_media_with_browser(
            page_url, on_log, should_cancel=should_cancel,
        )
    except DownloadCancelled:
        raise
    except Exception:
        _check_cancel(should_cancel)
        # Exception text can contain a signed media address; keep it out of logs.
        on_log("浏览器解析失败，尝试使用页面源码解析…")
        try:
            final_url, title, video_url, audio_url = extract_media_with_requests(
                page_url, should_cancel=should_cancel,
            )
        except requests.RequestException as error:
            raise DownloadNetworkError(error) from None
    _check_cancel(should_cancel)
    if not video_url:
        raise RuntimeError("未找到公开视频地址")

    video_id_match = VIDEO_ID_PATTERN.search(final_url) or VIDEO_ID_PATTERN.search(page_url)
    video_id = video_id_match.group(1) if video_id_match else str(int(time.time()))
    stem = safe_filename(title, f"douyin_{video_id}")
    output_path = unique_output_path(output_directory, stem)
    on_log(f"已找到视频：{title or video_id}")
    created_final = False
    try:
        if audio_url:
            on_log("检测到独立音频和视频轨道，正在下载并合并…")
            with tempfile.TemporaryDirectory(prefix="douyin_tracks_", dir=scratch_directory) as temporary_directory:
                temporary_directory_path = Path(temporary_directory)
                video_track_path = temporary_directory_path / "video.mp4"
                audio_track_path = temporary_directory_path / "audio.mp4"
                download_media(video_url, final_url, video_track_path,
                               lambda total, written: report("downloading_video", total, written),
                               should_cancel=should_cancel)
                download_media(audio_url, final_url, audio_track_path,
                               lambda total, written: report("downloading_audio", total, written),
                               should_cancel=should_cancel)
                report("merging")
                mux_media(video_track_path, audio_track_path, output_path,
                          ffmpeg_path=context.ffmpeg_path, should_cancel=should_cancel,
                          process_factory=context.process_factory)
        else:
            download_media(video_url, final_url, output_path,
                           lambda total, written: report("downloading_video", total, written),
                           should_cancel=should_cancel)
        created_final = True
        _check_cancel(should_cancel)
        report("completed", output_path.stat().st_size, output_path.stat().st_size)
        return DownloadCandidate(output_path, title, source)
    except Exception as error:
        if created_final:
            output_path.unlink(missing_ok=True)
        if isinstance(error, requests.RequestException):
            raise DownloadNetworkError(error) from None
        raise
