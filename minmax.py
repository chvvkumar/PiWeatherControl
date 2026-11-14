"""Persistent min/max of sensor readings.

Readings are folded into 10-minute buckets in a SQLite file, so a range query
is accurate to one bucket and the file grows by roughly 1 MB per month.
"""

import sqlite3
import time
from pathlib import Path
from typing import Optional

BUCKET_S = 600
FLUSH_S = 60  # buffer in memory between writes to spare the disk

_DAY = 86400
# Range key -> window length in seconds. None means no lower bound.
RANGES: dict[str, Optional[int]] = {
    "1h": 3600,
    "6h": 6 * 3600,
    "12h": 12 * 3600,
    "24h": _DAY,
    "7d": 7 * _DAY,
    "1mo": 30 * _DAY,
    "6mo": 182 * _DAY,
    "1y": 365 * _DAY,
    "all": None,
}


class MinMaxStore:
    def __init__(self, path: Path | str):
        # ponytail: one connection, calls serialized by the asyncio event loop
        # (never call from two threads at once); queries block the loop for a
        # few ms. Move to a worker thread with a lock if the table gets huge.
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS minmax ("
            " bucket INTEGER NOT NULL, metric TEXT NOT NULL,"
            " lo REAL NOT NULL, hi REAL NOT NULL,"
            " PRIMARY KEY (bucket, metric)) WITHOUT ROWID"
        )
        self._db.commit()
        self._pending: dict[tuple[int, str], list[float]] = {}
        self._last_flush = time.time()

    def record(self, values: dict, now: Optional[float] = None) -> None:
        """Fold one sample per metric into the current bucket. None is skipped."""
        now = time.time() if now is None else now
        bucket = int(now) // BUCKET_S * BUCKET_S
        for metric, v in values.items():
            if v is None:
                continue
            p = self._pending.setdefault((bucket, metric), [v, v])
            p[0] = min(p[0], v)
            p[1] = max(p[1], v)
        if now - self._last_flush >= FLUSH_S:
            self.flush(now)

    def flush(self, now: Optional[float] = None) -> None:
        """Write buffered buckets. On failure they stay buffered for a retry."""
        with self._db:
            self._db.executemany(
                "INSERT INTO minmax VALUES (?, ?, ?, ?)"
                " ON CONFLICT (bucket, metric) DO UPDATE SET"
                " lo = MIN(lo, excluded.lo), hi = MAX(hi, excluded.hi)",
                [(b, m, lo, hi) for (b, m), (lo, hi) in self._pending.items()],
            )
        self._pending.clear()
        self._last_flush = time.time() if now is None else now

    def query(self, range_key: str, now: Optional[float] = None) -> dict[str, list[float]]:
        """Return {metric: [min, max]} over the named range. KeyError if unknown."""
        seconds = RANGES[range_key]
        now = time.time() if now is None else now
        # Include the bucket that the start of the window falls inside.
        since = 0 if seconds is None else int(now - seconds) // BUCKET_S * BUCKET_S
        out = {
            m: [lo, hi]
            for m, lo, hi in self._db.execute(
                "SELECT metric, MIN(lo), MAX(hi) FROM minmax WHERE bucket >= ? GROUP BY metric",
                (since,),
            )
        }
        for (bucket, m), (lo, hi) in self._pending.items():
            if bucket >= since:
                cur = out.setdefault(m, [lo, hi])
                cur[0] = min(cur[0], lo)
                cur[1] = max(cur[1], hi)
        return out
