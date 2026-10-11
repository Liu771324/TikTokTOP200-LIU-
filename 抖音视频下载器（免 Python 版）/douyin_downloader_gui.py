"""Windows-friendly Tkinter interface for the shared Douyin download core."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk

# Keep the original module's helper imports available to existing callers.
from douyin_downloader_core import (
    USER_AGENT, DOUYIN_HOST_SUFFIXES, URL_PATTERN, VIDEO_ID_PATTERN,
    _is_douyin_host, extract_input_urls, safe_filename, is_public_video_url,
    media_kind, unique_output_path, extract_urls_from_html,
    extract_media_with_browser, extract_media_with_requests, download_media,
    find_ffmpeg, mux_media, download_from_link,
)


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
