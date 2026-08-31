"""Tests for the calendar sync's mapping and reconcile rules.

Nothing here touches Google. A fake Calendar records what would have been sent,
which is the only part of the sync that is hard to eyeball.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

import gcal_sync as g

DEFAULTS = g.Defaults(start="18:30", end="20:30",
                      location="Scout Hut, Cokesbury UMC",
                      site_url="https://troop3pensacola.org")
WINDOW = (dt.date(2026, 1, 1), dt.date(2027, 12, 31))


class FakeCalendar:
    """Stands in for Calendar. Remembers every write."""

    def __init__(self, items: list[dict[str, Any]] | None = None) -> None:
        self.items = items or []
        self.inserted: list[dict[str, Any]] = []
        self.patched: list[tuple[str, dict[str, Any]]] = []
        self.cancelled: list[str] = []
        self._n = 0

    def list(self, lo: dt.date, hi: dt.date) -> list[dict[str, Any]]:
        return self.items

    def insert(self, body: dict[str, Any]) -> str:
        self._n += 1
        self.inserted.append(body)
        return f"gid{self._n}"

    def patch(self, event_id: str, body: dict[str, Any]) -> bool:
        self.patched.append((event_id, body))
        return True

    def cancel(self, event_id: str) -> bool:
        self.cancelled.append(event_id)
        return True


def gevent(eid: str, summary: str, start: dict[str, str], end: dict[str, str],
           key: str | None = None, **extra: Any) -> dict[str, Any]:
    ev: dict[str, Any] = {"id": eid, "summary": summary, "start": start, "end": end,
                          "status": "confirmed", "updated": "2026-08-01T00:00:00Z"}
    if key:
        ev["extendedProperties"] = {"private": {"t3Key": key}}
    ev.update(extra)
    return ev


# ─────────────────────────────────────────────────────────────────── mapping


@pytest.mark.unit
def test_meeting_uses_the_troops_usual_hours_when_it_says_nothing() -> None:
    s = g.meeting_shared({"date": "2026-09-15", "title": "Knots"}, DEFAULTS)
    assert (s.start, s.end, s.all_day) == ("2026-09-15T18:30", "2026-09-15T20:30", False)
    assert s.location == "Scout Hut, Cokesbury UMC"


@pytest.mark.unit
def test_all_day_event_end_is_inclusive_here_and_exclusive_on_google() -> None:
    rec = {"slug": "fall", "date": "2026-08-28", "endDate": "2026-08-30", "title": "Campout"}
    s = g.event_shared(rec, DEFAULTS)
    assert (s.start, s.end, s.all_day) == ("2026-08-28", "2026-08-30", True)
    body = g.gcal_body(s, "e:fall", "", "")
    assert body["start"]["date"] == "2026-08-28"
    assert body["end"]["date"] == "2026-08-31"      # Google's end is the day after


@pytest.mark.unit
def test_a_google_all_day_event_round_trips_back_to_the_same_shape() -> None:
    s = g.event_shared({"slug": "fall", "date": "2026-08-28", "endDate": "2026-08-30",
                        "title": "Campout"}, DEFAULTS)
    ev = gevent("g1", "Campout", g.gcal_body(s, "e:fall", "", "")["start"],
                g.gcal_body(s, "e:fall", "", "")["end"], key="e:fall")
    assert g.gcal_shared(ev) == s


@pytest.mark.unit
def test_the_digest_ignores_the_description_the_site_owns() -> None:
    s = g.meeting_shared({"date": "2026-09-15", "title": "Knots"}, DEFAULTS)
    same = g.meeting_shared({"date": "2026-09-15", "title": "Knots",
                             "summary": "totally different prose",
                             "catchUp": "and a catch-up"}, DEFAULTS)
    assert s.digest == same.digest


# ────────────────────────────────────────────────────────────────── reconcile


@pytest.mark.unit
def test_a_meeting_the_calendar_has_never_seen_is_created_there() -> None:
    meetings = {"meetings": [{"date": "2026-09-15", "title": "Knots", "gcalEventId": ""}]}
    cal = FakeCalendar()
    report = g.sync(cal, meetings, {"events": []}, DEFAULTS, WINDOW)
    assert report.created_there == 1
    assert meetings["meetings"][0]["gcalEventId"] == "gid1"
    assert meetings["meetings"][0]["gcalSyncedHash"]
    assert cal.inserted[0]["extendedProperties"]["private"]["t3Key"] == "m:2026-09-15"


@pytest.mark.unit
def test_an_unchanged_pair_makes_no_calls_at_all() -> None:
    rec = {"date": "2026-09-15", "title": "Knots", "gcalEventId": "g1"}
    s = g.meeting_shared(rec, DEFAULTS)
    rec["gcalSyncedHash"] = s.digest
    body = g.gcal_body(s, "m:2026-09-15", "", "")
    cal = FakeCalendar([gevent("g1", "Knots", body["start"], body["end"], key="m:2026-09-15",
                               location=s.location)])
    report = g.sync(cal, {"meetings": [rec]}, {"events": []}, DEFAULTS, WINDOW)
    assert (report.pushed, report.pulled, report.created_there) == (0, 0, 0)
    assert cal.patched == [] and cal.inserted == []


@pytest.mark.unit
def test_a_site_edit_is_pushed_to_the_calendar() -> None:
    rec = {"date": "2026-09-15", "title": "Knots", "gcalEventId": "g1"}
    rec["gcalSyncedHash"] = g.meeting_shared(rec, DEFAULTS).digest
    rec["title"] = "Knots & Lashings"                       # the edit
    old = g.gcal_body(g.meeting_shared({"date": "2026-09-15", "title": "Knots"}, DEFAULTS),
                      "m:2026-09-15", "", "")
    cal = FakeCalendar([gevent("g1", "Knots", old["start"], old["end"], key="m:2026-09-15",
                               location=DEFAULTS.location)])
    report = g.sync(cal, {"meetings": [rec]}, {"events": []}, DEFAULTS, WINDOW)
    assert report.pushed == 1
    assert cal.patched[0][1]["summary"] == "Knots & Lashings"


@pytest.mark.unit
def test_a_calendar_edit_is_pulled_into_the_site() -> None:
    rec = {"date": "2026-09-15", "title": "Knots", "gcalEventId": "g1"}
    rec["gcalSyncedHash"] = g.meeting_shared(rec, DEFAULTS).digest
    moved = g.gcal_body(g.meeting_shared({"date": "2026-09-15", "title": "Knots",
                                          "start": "19:00", "end": "21:00"}, DEFAULTS),
                        "m:2026-09-15", "", "")
    cal = FakeCalendar([gevent("g1", "Knots at the church", moved["start"], moved["end"],
                               key="m:2026-09-15", location="Cokesbury UMC")])
    report = g.sync(cal, {"meetings": [rec]}, {"events": []}, DEFAULTS, WINDOW)
    assert report.pulled == 1
    assert rec["title"] == "Knots at the church"
    assert (rec["start"], rec["end"]) == ("19:00", "21:00")
    assert cal.patched == []                                # nothing pushed back


@pytest.mark.unit
def test_when_both_sides_moved_the_more_recent_one_wins() -> None:
    rec = {"date": "2026-09-15", "title": "Knots", "gcalEventId": "g1",
           "updated": "2026-08-20T00:00:00Z"}
    rec["gcalSyncedHash"] = g.meeting_shared(rec, DEFAULTS).digest
    rec["title"] = "Site version"
    theirs = g.gcal_body(g.meeting_shared({"date": "2026-09-15", "title": "x"}, DEFAULTS),
                         "m:2026-09-15", "", "")
    cal = FakeCalendar([gevent("g1", "Calendar version", theirs["start"], theirs["end"],
                               key="m:2026-09-15", location=DEFAULTS.location,
                               updated="2026-08-25T00:00:00Z")])   # newer than the site
    report = g.sync(cal, {"meetings": [rec]}, {"events": []}, DEFAULTS, WINDOW)
    assert report.conflicts == 1
    assert rec["title"] == "Calendar version"


@pytest.mark.unit
def test_cancelling_on_the_site_cancels_on_the_calendar() -> None:
    rec = {"date": "2026-09-15", "title": "Knots", "gcalEventId": "g1"}
    rec["gcalSyncedHash"] = g.meeting_shared(rec, DEFAULTS).digest
    rec["status"] = "cancelled"
    body = g.gcal_body(g.meeting_shared({"date": "2026-09-15", "title": "Knots"}, DEFAULTS),
                       "m:2026-09-15", "", "")
    cal = FakeCalendar([gevent("g1", "Knots", body["start"], body["end"], key="m:2026-09-15",
                               location=DEFAULTS.location)])
    g.sync(cal, {"meetings": [rec]}, {"events": []}, DEFAULTS, WINDOW)
    assert cal.cancelled == ["g1"]


@pytest.mark.unit
def test_deleting_on_the_calendar_cancels_on_the_site_but_keeps_the_record() -> None:
    rec = {"date": "2026-09-15", "title": "Knots", "gcalEventId": "g1", "status": "scheduled"}
    rec["gcalSyncedHash"] = g.meeting_shared(rec, DEFAULTS).digest
    body = g.gcal_body(g.meeting_shared(rec, DEFAULTS), "m:2026-09-15", "", "")
    ev = gevent("g1", "Knots", body["start"], body["end"], key="m:2026-09-15",
                location=DEFAULTS.location)
    ev["status"] = "cancelled"
    meetings = {"meetings": [rec]}
    g.sync(FakeCalendar([ev]), meetings, {"events": []}, DEFAULTS, WINDOW)
    assert meetings["meetings"] == [rec]                    # still there
    assert rec["status"] == "cancelled"


@pytest.mark.unit
def test_an_event_added_straight_into_google_appears_on_the_site() -> None:
    events: dict[str, Any] = {"events": []}
    ev = gevent("g9", "Council Camporee", {"date": "2026-10-16"}, {"date": "2026-10-19"},
                location="Camp Euchee", description="Bring a patrol flag.")
    report = g.sync(FakeCalendar([ev]), {"meetings": []}, events, DEFAULTS, WINDOW)
    assert report.created_here == 1
    added = events["events"][0]
    assert added["slug"] == "council-camporee"
    assert (added["date"], added["endDate"]) == ("2026-10-16", "2026-10-18")
    assert added["gcalEventId"] == "g9"
    assert added["summary"] == "Bring a patrol flag."
    assert added["source"] == "gcal"


@pytest.mark.unit
def test_our_own_event_is_not_imported_a_second_time() -> None:
    rec = {"slug": "fall", "date": "2026-08-28", "endDate": "2026-08-30",
           "title": "Campout", "gcalEventId": ""}
    s = g.event_shared(rec, DEFAULTS)
    body = g.gcal_body(s, "e:fall", "", "")
    events = {"events": [rec]}
    # The id was lost (a failed write), but the key still identifies it.
    report = g.sync(FakeCalendar([gevent("g5", "Campout", body["start"], body["end"],
                                         key="e:fall")]),
                    {"meetings": []}, events, DEFAULTS, WINDOW)
    assert report.created_here == 0 and report.created_there == 0
    assert len(events["events"]) == 1
    assert rec["gcalEventId"] == "g5"


@pytest.mark.unit
def test_records_outside_the_window_are_left_alone() -> None:
    rec = {"date": "2019-09-15", "title": "Ancient history", "gcalEventId": ""}
    cal = FakeCalendar()
    g.sync(cal, {"meetings": [rec]}, {"events": []}, DEFAULTS, WINDOW)
    assert cal.inserted == [] and rec["gcalEventId"] == ""
