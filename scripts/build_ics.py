"""Build calendar.ics from the troop's own schedule.

    python3 scripts/build_ics.py

Reads data/meetings.json, data/events.json and data/site.json; writes
calendar.ics at the root of the site, where GitHub Pages serves it as
text/calendar. Anyone can subscribe to it from Google Calendar, Apple Calendar
or Outlook and their copy keeps itself up to date.

Nothing here talks to Google. The site's JSON is the schedule; this file is
that schedule in the format calendar apps read. The arrow only ever points one
way, so there is no credential to hold, no permission to grant, and no way for
a bug in here to change anything on anybody's calendar but their view of ours.

Cancelled entries stay in the feed as STATUS:CANCELLED rather than vanishing,
which is what the rest of the site does too: a scout whose phone silently drops
a campout learns nothing, one whose phone says CANCELLED learns the thing that
matters.
"""

from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Chicago")
ROOT = Path(__file__).resolve().parent.parent
MEETINGS = ROOT / "data" / "meetings.json"
EVENTS = ROOT / "data" / "events.json"
SITE = ROOT / "data" / "site.json"
OUT = ROOT / "calendar.ics"

# Subscribers re-poll on their own schedule; this is the hint, not a guarantee.
# Google honours it loosely and can take a good deal longer.
REFRESH = "PT12H"


# ──────────────────────────────────────────────────────────────── the pieces


@dataclass(frozen=True)
class Defaults:
    """Meeting time and place from site.json, for meetings that omit them."""

    start: str
    end: str
    location: str
    site_url: str


@dataclass(frozen=True)
class Entry:
    """One VEVENT, already reduced to the strings it will be written as."""

    uid: str
    stamp: str                 # DTSTAMP, in UTC
    start: str                 # a UTC stamp, or 'YYYYMMDD' when all_day
    end: str                   # same; for all_day this is EXCLUSIVE, per RFC 5545
    all_day: bool
    summary: str
    location: str
    description: str
    url: str
    cancelled: bool


# ────────────────────────────────────────────────────────────── RFC 5545 bits


def esc(text: str) -> str:
    """Escape a TEXT value. Order matters: backslashes first, or we escape
    the escapes we just added."""
    return (text.replace("\\", "\\\\")
                .replace("\n", "\\n")
                .replace(";", "\\;")
                .replace(",", "\\,"))


def plain(text: str) -> str:
    """A one-line value with no escaping — for the X-WR-* properties."""
    return " ".join(text.split())


def fold(line: str) -> str:
    """Wrap to 75 octets, continuations led by one space.

    The limit is octets, not characters, so a line is folded on its UTF-8 bytes
    and never in the middle of one — a fold that splits a multi-byte character
    produces a file some clients reject outright.
    """
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    out, rest = [], raw
    limit = 75
    while len(rest) > limit:
        cut = limit
        while cut > 0 and (rest[cut] & 0xC0) == 0x80:   # don't split a codepoint
            cut -= 1
        out.append(rest[:cut].decode("utf-8"))
        rest = rest[cut:]
        limit = 74                                      # the leading space counts
    out.append(rest.decode("utf-8"))
    return "\r\n ".join(out)


def utc(date: str, hhmm: str) -> str:
    """'2026-09-15', '18:30' in the troop's zone -> '20260915T233000Z'.

    Written in UTC so the file needs no VTIMEZONE block. zoneinfo picks the
    right offset for that date, so a January meeting and a June meeting land
    correctly either side of the daylight-saving change.
    """
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    local = dt.datetime.fromisoformat(date).replace(hour=h, minute=m, tzinfo=TZ)
    return local.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def stamp_of(value: Any, fallback: str) -> str:
    """An ISO timestamp from the data -> a DTSTAMP, or the fallback.

    Deliberately the record's own 'updated' and not the time of the build: a
    DTSTAMP that moved every run would rewrite the whole file on every push and
    fill the history with commits that changed nothing.
    """
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return fallback
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# ────────────────────────────────────────────────────────────── site → entry


def _time(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if len(text) == 5 and text[2] == ":" else fallback


def meeting_entry(rec: dict[str, Any], d: Defaults, fallback: str) -> Entry | None:
    date = str(rec.get("date") or "")
    if not date:
        return None
    start, end = _time(rec.get("start"), d.start), _time(rec.get("end"), d.end)
    return Entry(
        uid=f"meeting-{date}@troop3pensacola.org",
        stamp=stamp_of(rec.get("updated"), fallback),
        start=utc(date, start),
        end=utc(date, end),
        all_day=False,
        summary=str(rec.get("title") or "Troop meeting"),
        location=str(rec.get("location") or d.location),
        description=describe(rec, f"{d.site_url}/meeting.html?d={date}" if d.site_url else ""),
        url=f"{d.site_url}/meeting.html?d={date}" if d.site_url else "",
        cancelled=str(rec.get("status") or "") == "cancelled",
    )


def event_entry(rec: dict[str, Any], d: Defaults, fallback: str) -> Entry | None:
    date, slug = str(rec.get("date") or ""), str(rec.get("slug") or "")
    if not date or not slug:
        return None
    last = str(rec.get("endDate") or date)
    link = f"{d.site_url}/event.html?e={slug}" if d.site_url else ""
    start_time = _time(rec.get("start"), "")
    common = {
        "uid": f"event-{slug}@troop3pensacola.org",
        "stamp": stamp_of(rec.get("updated"), fallback),
        "summary": str(rec.get("title") or "Troop 3 event"),
        "location": str(rec.get("location") or ""),
        "description": describe(rec, link),
        "url": link,
        "cancelled": str(rec.get("status") or "") == "cancelled",
    }
    if start_time:
        end_time = _time(rec.get("end"), "") or start_time
        return Entry(start=utc(date, start_time), end=utc(last, end_time),
                     all_day=False, **common)
    # All-day. RFC 5545's DTEND is the morning after the last day, not the last
    # day — get this wrong and every campout shows a day short.
    exclusive = (dt.date.fromisoformat(last) + dt.timedelta(days=1)).isoformat()
    return Entry(start=date.replace("-", ""), end=exclusive.replace("-", ""),
                 all_day=True, **common)


def describe(rec: dict[str, Any], link: str) -> str:
    """What a subscriber sees in their calendar app. The site is always fuller."""
    parts = [str(rec.get("summary") or "").strip()]
    if str(rec.get("catchUp") or "").strip():
        parts.append("A catch-up for this one is posted on the website.")
    if link:
        parts.append(link)
    return "\n\n".join(p for p in parts if p)


# ────────────────────────────────────────────────────────────────── rendering


def render(entries: list[Entry], name: str, description: str) -> str:
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Troop 3 Pensacola//Schedule//EN",
        "CALSCALE:GREGORIAN",
        # X-WR-* are not RFC properties and clients render them raw, backslashes
        # and all, so these two are passed through plain rather than escaped.
        f"X-WR-CALNAME:{plain(name)}",
        f"X-WR-CALDESC:{plain(description)}",
        "X-WR-TIMEZONE:America/Chicago",
        f"REFRESH-INTERVAL;VALUE=DURATION:{REFRESH}",
        f"X-PUBLISHED-TTL:{REFRESH}",
    ]
    for e in sorted(entries, key=lambda x: (x.start, x.uid)):
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{e.uid}")
        lines.append(f"DTSTAMP:{e.stamp}")
        if e.all_day:
            lines.append(f"DTSTART;VALUE=DATE:{e.start}")
            lines.append(f"DTEND;VALUE=DATE:{e.end}")
        else:
            lines.append(f"DTSTART:{e.start}")
            lines.append(f"DTEND:{e.end}")
        lines.append(f"SUMMARY:{esc(e.summary)}")
        if e.location:
            lines.append(f"LOCATION:{esc(e.location)}")
        if e.description:
            lines.append(f"DESCRIPTION:{esc(e.description)}")
        if e.url:
            lines.append(f"URL:{e.url}")
        lines.append(f"STATUS:{'CANCELLED' if e.cancelled else 'CONFIRMED'}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"


# ───────────────────────────────────────────────────────────────────── main


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build(site: dict[str, Any], meetings: dict[str, Any], events: dict[str, Any]) -> str:
    meeting = site.get("meeting") or {}
    unit = site.get("unit") or {}
    d = Defaults(
        start=_time(meeting.get("start"), "18:30"),
        end=_time(meeting.get("end"), "20:30"),
        location=str(meeting.get("location") or ""),
        site_url=str(site.get("url") or "").rstrip("/"),
    )
    entries: list[Entry] = []
    for rec in meetings.get("meetings", []):
        got = meeting_entry(rec, d, stamp_of(meetings.get("updated"), "19700101T000000Z"))
        if got:
            entries.append(got)
    for rec in events.get("events", []):
        got = event_entry(rec, d, stamp_of(events.get("updated"), "19700101T000000Z"))
        if got:
            entries.append(got)
    place = str((site.get("unit") or {}).get("tagline") or "").split("—")[0]
    return render(
        entries,
        " ".join(f"{unit.get('name') or 'Troop 3'} {place}".split()).rstrip(","),
        "Meetings, campouts, courts of honour and service projects.",
    )


def main() -> int:
    text = build(load(SITE), load(MEETINGS), load(EVENTS))
    # Bytes, both ways. RFC 5545 wants CRLF, and text mode would translate the
    # line endings on the way in and out — which reads back as a difference
    # every single time and commits a file that has not changed.
    raw = text.encode("utf-8")
    if OUT.exists() and OUT.read_bytes() == raw:
        print(f"{OUT.name} is already current.")
        return 0
    OUT.write_bytes(raw)
    print(f"Wrote {OUT.name} — {text.count('BEGIN:VEVENT')} entries.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
