import math
import re

from .errors import ToolboxError


def validate_fingerprint(value):
    if value is None:
        return
    if (type(value) is not dict or type(value.get('duration')) not in (int, float)
            or not math.isfinite(value['duration']) or value['duration'] <= 0
            or type(value.get('frames')) is not list
            or any(not isinstance(frame, str) or not re.fullmatch(r'[a-f0-9]{16}', frame) for frame in value['frames'])):
        raise ToolboxError('INVALID_PARAMETERS', '视频指纹格式无效。')


def overlap(left, right, *, opening=False):
    a, b = left['frames'], right['frames']
    if opening:
        a, b = a[:5], b[:5]
    elif max(len(a), len(b)) < 12:
        return 0
    if not a or not b:
        return 0
    limit = 16 if opening else 12
    a, b = [int(frame, 16) for frame in a], [int(frame, 16) for frame in b]
    previous = [0] * (len(b) + 1)
    for frame in a:
        current = [0]
        for index, other in enumerate(b):
            current.append(previous[index] + 1 if (frame ^ other).bit_count() <= limit
                           else max(previous[index + 1], current[-1]))
        previous = current
    # Match JavaScript Math.round for nonnegative values.
    return math.floor(previous[-1] / min(len(a), len(b)) * 100 + .5)


def best_match(candidate, entries):
    validate_fingerprint(candidate)
    if candidate is None:
        return None
    best = None
    for entry in entries:
        opening = overlap(candidate, entry['fingerprint'], opening=True)
        sequence = overlap(candidate, entry['fingerprint'])
        percent = opening if opening >= 80 else sequence
        if percent >= 80 and (best is None or percent > best['matchPercent']):
            best = {'artifactId': entry['artifactId'], 'matchPercent': percent,
                    'matchReason': '开头人物或主体画面' if opening >= 80 else '较短视频主体内容'}
    return best
