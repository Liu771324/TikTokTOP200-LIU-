import unittest
from datetime import datetime, timedelta

from cost_sync.windows import iter_time_windows


class WindowTests(unittest.TestCase):
    def test_windows_do_not_exceed_seven_days_or_lose_seconds(self) -> None:
        start = datetime(2026, 1, 1, 0, 0, 0)
        end = datetime(2026, 1, 15, 0, 0, 1)
        windows = list(iter_time_windows(start, end, window_days=7))

        self.assertEqual(start, windows[0][0])
        self.assertEqual(end, windows[-1][1])
        for index, (begin, finish) in enumerate(windows):
            self.assertLessEqual(finish - begin, timedelta(days=7))
            if index:
                self.assertEqual(windows[index - 1][1] + timedelta(seconds=1), begin)

    def test_invalid_window_size_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            list(iter_time_windows(datetime.now(), datetime.now(), window_days=8))


if __name__ == "__main__":
    unittest.main()

