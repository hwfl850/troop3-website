"""Two-way sync between the Troop 3 site's JSON and the troop Google Calendar.

Runs in GitHub Actions (see .github/workflows/gcal-sync.yml):

  * on a push that touches data/  -> the site's edits reach the calendar
  * on a schedule                 -> the calendar's edits reach the site

Both directions are the same reconcile pass, so there is one implementation and
one place to debug it.

Ownership
---------
The calendar and the site share only what a calendar can express: title, when,
where, and whether it is cancelled. Everything that makes this site worth
visiting -- catch-ups, packing lists, materials, uniform, patrol tags -- lives
only in the JSON and is never touched by a sync.

Loop prevention
---------------
Every record stores ``gcalSyncedHash``: a hash of the shared fields as they
stood the last time the two sides agreed. A side "changed" only if its current
hash differs from that. If both changed, the more recently updated side wins.
An echo of our own write hashes identically and is ignored.

Deletion
--------
Never. A calendar event that disappears makes the site record ``cancelled``,
which is what the rest of the site is built to display.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from zoneinfo import ZoneInfo

API = "https://www.googleapis.com/calendar/v3"
SCOPES = ("https://www.googleapis.com/auth/calendar.events",)
TZ = ZoneInfo("America/Chicago")
TZ_NAME = "America/Chicago"

ROOT = Path(__file__).resolve().parent.parent
MEETINGS = ROOT / "data" / "meetings.json"
EVENTS = ROOT / "data" / "events.json"
SITE = ROOT / "data" / "site.json"

# How much of the schedule the calendar carries. Older meetings stay on the site
# but are not worth pushing, and a window keeps the list call cheap.
DAYS_BACK = 180
DAYS_AHEAD = 400

Kind = Literal["meeting", "event"]


# ─────────────────────────────────────────────────────────────── the shared bit


@dataclass(frozen=True)
class Shared:
    """The fields both sides are allowed to have an opinion about."""

    title: str
    start: str      # 'YYYY-MM-DD' for all-day, else 'YYYY-MM-DDTHH:MM'
    end: str        # same; for all-day this is the INCLUSIVE last day
    all_day: bool
    location: str
    cancelled: bool

    @property
    def digest(self) -> str:
        raw = json.dumps(
            [self.title.strip(), self.start, self.end, self.all_day,
             self.location.strip(), self.cancelled],
            separators=(",", ":"), ensure_ascii=False,
        )
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class Defaults:
    """Meeting time and place from site.json, used when a meeting omits them."""

    start: str
    end: str
    location: str
    site_url: str


# ───────────────────────────────────────────────────────────────── site → shape


def _time(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if len(text) == 5 and text[2] == ":" else fallback


def meeting_shared(rec: dict[str, Any], d: Defaults) -> Shared:
    date = str(rec["date"])
    start = _time(rec.get("start"), d.start)
    end = _time(rec.get("end"), d.end)
    return Shared(
        title=str(rec.get("title") or "Troop meeting"),
        start=f"{date}T{start}",
        end=f"{date}T{end}",
        all_day=False,
        location=str(rec.get("location") or d.location),
        cancelled=str(rec.get("status") or "") == "cancelled",
    )


def event_shared(rec: dict[str, Any], d: Defaults) -> Shared:
    date = str(rec["date"])
    last = str(rec.get("endDate") or date)
    start_time = _time(rec.get("start"), "")
    if start_time:
        end_time = _time(rec.get("end"), "")
        return Shared(
            title=str(rec.get("title") or "Troop 3 event"),
            start=f"{date}T{start_time}",
            end=f"{last}T{end_time or start_time}",
            all_day=False,
            location=str(rec.get("location") or ""),
            cancelled=str(rec.get("status") or "") == "cancelled",
        )
    return Shared(
        title=str(rec.get("title") or "Troop 3 event"),
        start=date,
        end=last,
        all_day=True,
        location=str(rec.get("location") or ""),
        cancelled=str(rec.get("status") or "") == "cancelled",
    )


def apply_shared(rec: dict[str, Any], kind: Kind, s: Shared, d: Defaults) -> None:
    """Write calendar-side values back onto a site record, in place."""
    rec["title"] = s.title
    if s.all_day:
        rec["date"] = s.start
        rec.pop("start", None)
        rec.pop("end", None)
        if s.end != s.start:
            rec["endDate"] = s.end
        else:
            rec.pop("endDate", None)
    else:
        rec["date"] = s.start[:10]
        start_time, end_time = s.start[11:16], s.end[11:16]
        # A meeting at the troop's usual hours does not need to say so.
        if kind == "meeting" and start_time == d.start and end_time == d.end:
            rec.pop("start", None)
            rec.pop("end", None)
        else:
            rec["start"] = start_time
            rec["end"] = end_time
        if kind == "event" and s.end[:10] != s.start[:10]:
            rec["endDate"] = s.end[:10]

    if s.location and s.location != d.location:
        rec["location"] = s.location
    elif kind == "event":
        rec["location"] = s.location

    if s.cancelled:
        rec["status"] = "cancelled"
    elif str(rec.get("status") or "") == "cancelled":
        rec["status"] = "scheduled"


# ────────────────────────────────────────────────────────────── google → shape


def _local(stamp: str) -> str:
    """RFC3339 with an offset -> 'YYYY-MM-DDTHH:MM' in the troop's zone."""
    parsed = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(TZ).strftime("%Y-%m-%dT%H:%M")


def gcal_shared(ev: dict[str, Any]) -> Shared:
    start, end = ev.get("start") or {}, ev.get("end") or {}
    if start.get("date"):
        first = str(start["date"])
        # Google's all-day end is exclusive; the site's is the last day itself.
        raw_end = str(end.get("date") or first)
        last = (dt.date.fromisoformat(raw_end) - dt.timedelta(days=1)).isoformat()
        return Shared(
            title=str(ev.get("summary") or ""),
            start=first,
            end=max(last, first),
            all_day=True,
            location=str(ev.get("location") or ""),
            cancelled=ev.get("status") == "cancelled",
        )
    first = _local(str(start.get("dateTime")))
    return Shared(
        title=str(ev.get("summary") or ""),
        start=first,
        end=_local(str(end.get("dateTime") or start.get("dateTime"))),
        all_day=False,
        location=str(ev.get("location") or ""),
        cancelled=ev.get("status") == "cancelled",
    )


def gcal_body(s: Shared, key: str, description: str, link: str) -> dict[str, Any]:
    if s.all_day:
        exclusive = (dt.date.fromisoformat(s.end) + dt.timedelta(days=1)).isoformat()
        when = {"start": {"date": s.start}, "end": {"date": exclusive}}
    else:
        when = {
            "start": {"dateTime": f"{s.start}:00", "timeZone": TZ_NAME},
            "end": {"dateTime": f"{s.end}:00", "timeZone": TZ_NAME},
        }
    body: dict[str, Any] = {
        "summary": s.title,
        "location": s.location,
        "description": description,
        "extendedProperties": {"private": {"t3Key": key}},
        **when,
    }
    if link:
        body["source"] = {"title": "Troop 3 website", "url": link}
    return body


def describe(rec: dict[str, Any], link: str) -> str:
    """What the calendar entry says. The site is always the fuller answer."""
    parts = [str(rec.get("summary") or "").strip()]
    if str(rec.get("catchUp") or "").strip():
        parts.append("A catch-up for this one is posted on the website.")
    if link:
        parts.append(link)
    return "\n\n".join(p for p in parts if p)


# ──────────────────────────────────────────────────────────────── the calendar


class Calendar:
    """The four calls this sync makes, and nothing else."""

    def __init__(self, calendar_id: str, credentials: Any, dry_run: bool) -> None:
        from google.auth.transport.requests import AuthorizedSession

        self.calendar_id = calendar_id
        self.dry_run = dry_run
        self.session = AuthorizedSession(credentials)

    def _url(self, suffix: str = "") -> str:
        from urllib.parse import quote

        return f"{API}/calendars/{quote(self.calendar_id, safe='')}/events{suffix}"

    def list(self, lo: dt.date, hi: dt.date) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        params: dict[str, Any] = {
            "timeMin": f"{lo.isoformat()}T00:00:00Z",
            "timeMax": f"{hi.isoformat()}T00:00:00Z",
            "singleEvents": "true",
            "showDeleted": "true",
            "maxResults": 2500,
        }
        while True:
            r = self.session.get(self._url(), params=params, timeout=30)
            r.raise_for_status()
            page = r.json()
            out.extend(page.get("items") or [])
            token = page.get("nextPageToken")
            if not token:
                return out
            params["pageToken"] = token

    def insert(self, body: dict[str, Any]) -> str:
        if self.dry_run:
            return "dry-run-id"
        r = self.session.post(self._url(), json=body, timeout=30)
        r.raise_for_status()
        return str(r.json()["id"])

    def patch(self, event_id: str, body: dict[str, Any]) -> bool:
        """False means the event is gone on Google's side."""
        if self.dry_run:
            return True
        r = self.session.patch(self._url(f"/{event_id}"), json=body, timeout=30)
        if r.status_code in (404, 410):
            return False
        r.raise_for_status()
        return True

    def cancel(self, event_id: str) -> bool:
        if self.dry_run:
            return True
        r = self.session.patch(self._url(f"/{event_id}"), json={"status": "cancelled"}, timeout=30)
        if r.status_code in (404, 410):
            return False
        r.raise_for_status()
        return True


# ───────────────────────────────────────────────────────────────── the reconcile


@dataclass
class Report:
    pushed: int = 0
    pulled: int = 0
    created_here: int = 0
    created_there: int = 0
    conflicts: int = 0

    def __str__(self) -> str:
        return (f"{self.created_there} created on the calendar, {self.pushed} updated there; "
                f"{self.created_here} created on the site, {self.pulled} updated here; "
                f"{self.conflicts} conflicts resolved by recency")


def _updated(value: Any) -> dt.datetime:
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def now_stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sync(cal: Calendar, meetings: dict[str, Any], events: dict[str, Any],
         d: Defaults, window: tuple[dt.date, dt.date]) -> Report:
    lo, hi = window
    report = Report()
    remote = cal.list(lo, hi)
    by_id = {str(e["id"]): e for e in remote}
    by_key: dict[str, dict[str, Any]] = {}
    for e in remote:
        key = ((e.get("extendedProperties") or {}).get("private") or {}).get("t3Key")
        if key:
            by_key.setdefault(str(key), e)
    claimed: set[str] = set()

    records: list[tuple[Kind, dict[str, Any]]] = (
        [("meeting", m) for m in meetings.get("meetings", [])]
        + [("event", e) for e in events.get("events", [])]
    )

    for kind, rec in records:
        date = str(rec.get("date") or "")
        if not date or not (lo.isoformat() <= date <= hi.isoformat()):
            continue

        if kind == "meeting":
            key = f"m:{date}"
            shared = meeting_shared(rec, d)
            link = f"{d.site_url}/meeting.html?d={date}" if d.site_url else ""
        else:
            slug = str(rec.get("slug") or "")
            if not slug:
                continue
            key = f"e:{slug}"
            shared = event_shared(rec, d)
            link = f"{d.site_url}/event.html?e={slug}" if d.site_url else ""

        event_id = str(rec.get("gcalEventId") or "")
        ev = by_id.get(event_id) or by_key.get(key)
        if ev is not None:
            claimed.add(str(ev["id"]))

        body = gcal_body(shared, key, describe(rec, link), link)

        # ── not on the calendar yet ─────────────────────────────────────────
        if ev is None:
            if shared.cancelled:
                continue                      # never create something already off
            rec["gcalEventId"] = cal.insert(body)
            rec["gcalSyncedHash"] = shared.digest
            report.created_there += 1
            print(f"  + calendar: {key} — {shared.title}")
            continue

        rec["gcalEventId"] = str(ev["id"])
        theirs = gcal_shared(ev)
        base = str(rec.get("gcalSyncedHash") or "")
        mine_changed = shared.digest != base
        theirs_changed = theirs.digest != base

        if theirs.digest == shared.digest:
            rec["gcalSyncedHash"] = shared.digest
            continue

        if mine_changed and theirs_changed:
            report.conflicts += 1
            site_wins = _updated(rec.get("updated")) >= _updated(ev.get("updated"))
            print(f"  ! conflict on {key}: {'site' if site_wins else 'calendar'} is newer")
        else:
            site_wins = mine_changed

        if site_wins:
            if shared.cancelled and not theirs.cancelled:
                ok = cal.cancel(str(ev["id"]))
            else:
                ok = cal.patch(str(ev["id"]), body)
            if not ok:
                rec["gcalEventId"] = ""       # gone on Google's side; recreate next run
                rec["gcalSyncedHash"] = ""
                print(f"  ? {key} no longer exists on the calendar; will recreate")
                continue
            rec["gcalSyncedHash"] = shared.digest
            report.pushed += 1
            print(f"  > calendar: {key} — {shared.title}")
        else:
            apply_shared(rec, kind, theirs, d)
            rec["gcalSyncedHash"] = theirs.digest
            rec["updated"] = now_stamp()
            report.pulled += 1
            print(f"  < site: {key} — {theirs.title}")

    # ── events somebody added straight into Google Calendar ─────────────────
    for ev in remote:
        if str(ev["id"]) in claimed or ev.get("status") == "cancelled":
            continue
        if ((ev.get("extendedProperties") or {}).get("private") or {}).get("t3Key"):
            continue                          # ours, but its record is gone: leave it
        if not (ev.get("summary") or "").strip():
            continue
        theirs = gcal_shared(ev)
        fresh: dict[str, Any] = {
            "slug": unique_slug(theirs.title, theirs.start[:10], events),
            "date": theirs.start[:10],
            "title": theirs.title,
            "kind": "event",
            "status": "scheduled",
            "summary": str(ev.get("description") or "").strip(),
            "source": "gcal",
            "gcalEventId": str(ev["id"]),
            "gcalSyncedHash": theirs.digest,
            "updated": now_stamp(),
        }
        apply_shared(fresh, "event", theirs, d)
        events.setdefault("events", []).append(fresh)
        report.created_here += 1
        print(f"  + site: {fresh['slug']} — {theirs.title}")

    events["events"] = sorted(events.get("events", []), key=lambda r: str(r.get("date") or ""))
    return report


def unique_slug(title: str, date: str, events: dict[str, Any]) -> str:
    stem = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")
    while "--" in stem:
        stem = stem.replace("--", "-")
    stem = (stem or "event")[:40].strip("-")
    taken = {str(e.get("slug") or "") for e in events.get("events", [])}
    if stem not in taken:
        return stem
    dated = f"{stem}-{date[:4]}"
    if dated not in taken:
        return dated
    n = 2
    while f"{dated}-{n}" in taken:
        n += 1
    return f"{dated}-{n}"


# ─────────────────────────────────────────────────────────────────────── main


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def differs(path: Path, data: dict[str, Any]) -> bool:
    """True if anything but the file's own updated stamp has moved."""
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    return json.dumps({**on_disk, "updated": ""}, sort_keys=True, ensure_ascii=False) != \
        json.dumps({**data, "updated": ""}, sort_keys=True, ensure_ascii=False)


def write(path: Path, data: dict[str, Any]) -> bool:
    """Write only if the file actually changes, so no-op runs make no commit."""
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="say what would change on both sides, change nothing")
    args = ap.parse_args(argv)

    calendar_id = os.environ.get("GCAL_CALENDAR_ID", "").strip()
    key_json = os.environ.get("GCAL_SA_JSON", "").strip()
    if not calendar_id or not key_json:
        print("GCAL_CALENDAR_ID or GCAL_SA_JSON is not set — nothing to sync.")
        return 0

    site = load(SITE)
    # The kill switch. Leadership can stop the sync by setting this to false in
    # data/site.json without anyone needing access to GitHub or to Google.
    if not (site.get("flags") or {}).get("gcalSync"):
        print("flags.gcalSync is off in data/site.json — nothing to sync.")
        return 0

    meeting = site.get("meeting") or {}
    defaults = Defaults(
        start=_time(meeting.get("start"), "18:30"),
        end=_time(meeting.get("end"), "20:30"),
        location=str(meeting.get("location") or ""),
        site_url=str(site.get("url") or "").rstrip("/"),
    )

    from google.oauth2 import service_account

    creds = service_account.Credentials.from_service_account_info(
        json.loads(key_json), scopes=list(SCOPES))
    cal = Calendar(calendar_id, creds, args.dry_run)

    today = dt.datetime.now(TZ).date()
    window = (today - dt.timedelta(days=DAYS_BACK), today + dt.timedelta(days=DAYS_AHEAD))

    meetings, events = load(MEETINGS), load(EVENTS)
    print(f"Syncing {window[0]} … {window[1]} with {calendar_id}")
    report = sync(cal, meetings, events, defaults, window)
    print(report)

    if args.dry_run:
        print("Dry run: nothing written.")
        return 0

    changed = False
    for path, data in ((MEETINGS, meetings), (EVENTS, events)):
        # The file's own "updated" stamp must not be the only thing that moved,
        # or every quiet run would make a commit.
        if not differs(path, data):
            continue
        data["updated"] = now_stamp()
        changed |= write(path, data)
    print("Files changed." if changed else "Nothing to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
