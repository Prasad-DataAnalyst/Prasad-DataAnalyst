"""Reference Hampel identifier for the TW-TIME-007 test vector.

Window of 7 values (3 each side), median absolute deviation scaled by 1.4826, k = 3. A value is
flagged when MAD > 0 and |x - median| > k * 1.4826 * MAD. Values with fewer than 3 neighbours on
either side are not tested; None values are left out of the series first.
Run: python3 hampel_reference.py > hampel-series.json
"""
import json
import statistics

SERIES = [
    10.0, 10.2, 9.9, 10.1, 10.0, 10.3, 25.0, 10.1, 9.8, 10.0,
    10.2, None, 10.1, 9.9, 10.0, -4.0, 10.1, 10.2, 9.9, 10.0,
    10.1, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 18.0, 10.1,
    9.9, 10.2, 10.0, 10.1, 9.8, 10.0, 10.3, 10.1, 30.0, 10.0,
]
WINDOW, K, SCALE = 7, 3.0, 1.4826


def hampel(values):
    half = WINDOW // 2
    present = [(i, v) for i, v in enumerate(values) if v is not None]
    out = []
    for p in range(half, len(present) - half):
        win = [v for _, v in present[p - half : p + half + 1]]
        med = statistics.median(win)
        mad = statistics.median([abs(v - med) for v in win])
        index, value = present[p]
        if mad > 0 and abs(value - med) > K * SCALE * mad:
            out.append(index)
    return out


print(json.dumps({"window": WINDOW, "k": K, "series": SERIES, "outliers": hampel(SERIES)}, indent=2))
