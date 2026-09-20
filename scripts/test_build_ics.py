"""Tests for the .ics build.

The feed is the one thing on this site that other people's software reads, and
it is read by software we cannot see and cannot fix. So these lean on the parts
of RFC 5545 that are easy to get subtly wrong and hard to notice: the exclusive
all-day end, folding on octets, escaping, and the daylight-saving change.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest

import build_ics as b

DEFAULTS = b.Defaults(start="18:30", end="20:30",
                      location="Scout Hut, Cokesbury UMC",
                      site_url="https://troop3pensacola.org")
STAMP = "20260101T000000Z"


# ────────────────────────────────────────────────────────────────── escaping


@pytest.mark.unit
def test_escaping_covers_the_four_characters_that_matter() -> None:
    assert b.esc("a,b;c\\d\ne") == "a\\,b\\;c\\\\d\\ne"


@pytest.mark.unit
def test_backslashes_are_escaped_before_the_characters_we_add() -> None:
    # If the order were wrong this would come back as a quadruple backslash.
    assert b.esc("\\") == "\\\\"


@pytest.mark.unit
def test_the_calendar_name_is_not_escaped() -> None:
    # X-WR-* are not RFC properties; clients print them literally.
    assert b.plain("Troop 3 Pensacola, Florida") == "Troop 3 Pensacola, Florida"


# ─────────────────────────────────────────────────────────────────── folding


@pytest.mark.unit
def test_a_short_line_is_left_alone() -> None:
    assert b.fold("SUMMARY:Knots") == "SUMMARY:Knots"


@pytest.mark.unit
def test_a_long_line_folds_to_75_octets_with_a_leading_space() -> None:
    folded = b.fold("DESCRIPTION:" + "x" * 200)
    parts = folded.split("\r\n")
    assert len(parts[0].encode()) == 75
    assert all(p.startswith(" ") for p in parts[1:])
    # unfolding puts it back exactly
    assert parts[0] + "".join(p[1:] for p in parts[1:]) == "DESCRIPTION:" + "x" * 200


@pytest.mark.unit
def test_folding_never_splits_a_multibyte_character() -> None:
    line = "DESCRIPTION:" + "é" * 100
    for piece in b.fold(line).split("\r\n"):
        piece.encode("utf-8").decode("utf-8")       # would raise if split badly
    assert "é" * 100 in b.fold(line).replace("\r\n ", "")


# ────────────────────────────────────────────────────────── times & all-day


@pytest.mark.unit
def test_a_summer_meeting_is_five_hours_off_utc() -> None:
    assert b.utc("2026-07-28", "18:30") == "20260728T233000Z"


@pytest.mark.unit
def test_a_winter_meeting_is_six_hours_off_utc() -> None:
    """The same wall-clock time, the other side of the daylight-saving change."""
    assert b.utc("2026-12-08", "18:30") == "20261209T003000Z"


@pytest.mark.unit
def test_an_all_day_events_end_is_the_morning_after_the_last_day() -> None:
    rec = {"slug": "shakedown", "date": "2026-08-28", "endDate": "2026-08-30",
           "title": "Fall Shakedown"}
    e = b.event_entry(rec, DEFAULTS, STAMP)
    assert e is not None and e.all_day
    assert (e.start, e.end) == ("20260828", "20260831")


@pytest.mark.unit
def test_a_one_day_all_day_event_still_ends_the_next_morning() -> None:
    e = b.event_entry({"slug": "x", "date": "2026-09-05", "title": "Service Day"},
                      DEFAULTS, STAMP)
    assert e is not None and (e.start, e.end) == ("20260905", "20260906")


@pytest.mark.unit
def test_an_event_with_a_start_time_is_not_all_day() -> None:
    e = b.event_entry({"slug": "x", "date": "2026-09-05", "title": "Breakfast",
                       "start": "07:00", "end": "09:00"}, DEFAULTS, STAMP)
    assert e is not None and not e.all_day
    assert e.start == "20260905T120000Z"


# ───────────────────────────────────────────────────────────────── the record


@pytest.mark.unit
def test_a_meeting_falls_back_to_the_troops_usual_hours_and_place() -> None:
    e = b.meeting_entry({"date": "2026-09-15", "title": "Knots"}, DEFAULTS, STAMP)
    assert e is not None
    assert (e.start, e.end) == ("20260915T233000Z", "20260916T013000Z")
    assert e.location == "Scout Hut, Cokesbury UMC"


@pytest.mark.unit
def test_a_meeting_can_override_the_usual_hours() -> None:
    e = b.meeting_entry({"date": "2026-11-03", "title": "Court of Honor",
                         "start": "19:00", "end": "20:30"}, DEFAULTS, STAMP)
    assert e is not None and e.start == "20261104T010000Z"


@pytest.mark.unit
def test_a_cancelled_record_stays_in_the_feed() -> None:
    """Dropping it would tell a subscriber nothing; CANCELLED tells them."""
    e = b.meeting_entry({"date": "2026-10-27", "title": "No Meeting",
                         "status": "cancelled"}, DEFAULTS, STAMP)
    assert e is not None and e.cancelled
    assert "STATUS:CANCELLED" in b.render([e], "T3", "d")


@pytest.mark.unit
def test_uids_are_stable_across_runs() -> None:
    rec = {"date": "2026-09-15", "title": "Knots"}
    first = b.meeting_entry(rec, DEFAULTS, STAMP)
    second = b.meeting_entry({**rec, "title": "Knots and Lashings"}, DEFAULTS, STAMP)
    assert first is not None and second is not None
    # A renamed meeting must update in place, not appear twice on a phone.
    assert first.uid == second.uid


@pytest.mark.unit
def test_an_event_with_no_slug_is_skipped() -> None:
    assert b.event_entry({"date": "2026-09-05", "title": "Nameless"}, DEFAULTS, STAMP) is None


@pytest.mark.unit
def test_a_record_with_no_date_is_skipped() -> None:
    assert b.meeting_entry({"title": "Someday"}, DEFAULTS, STAMP) is None


@pytest.mark.unit
def test_the_dtstamp_comes_from_the_record_not_the_clock() -> None:
    """A DTSTAMP that moved every run would rewrite the file on every push."""
    e = b.meeting_entry({"date": "2026-09-15", "title": "Knots",
                         "updated": "2026-08-08T18:02:00Z"}, DEFAULTS, STAMP)
    assert e is not None and e.stamp == "20260808T180200Z"


@pytest.mark.unit
def test_a_record_with_no_updated_falls_back_rather_than_using_now() -> None:
    e = b.meeting_entry({"date": "2026-09-15", "title": "Knots"}, DEFAULTS, STAMP)
    assert e is not None and e.stamp == STAMP


# ───────────────────────────────────────────────────────────────── the whole


def _site() -> dict[str, Any]:
    return {"url": "https://troop3pensacola.org",
            "unit": {"name": "Troop 3", "tagline": "Pensacola, Florida — founded 1937"},
            "meeting": {"start": "18:30", "end": "20:30",
                        "location": "Scout Hut, Cokesbury UMC"}}


@pytest.mark.unit
def test_the_whole_file_has_the_envelope_a_client_expects() -> None:
    out = b.build(_site(), {"meetings": [{"date": "2026-09-15", "title": "Knots"}]},
                  {"events": []})
    assert out.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")
    assert out.endswith("END:VCALENDAR\r\n")
    assert "\r\n" in out and "\n\n" not in out


@pytest.mark.unit
def test_the_build_is_byte_for_byte_repeatable() -> None:
    site, m, e = _site(), {"meetings": [{"date": "2026-09-15", "title": "Knots"}]}, {"events": []}
    assert b.build(site, m, e) == b.build(site, m, e)


@pytest.mark.unit
def test_entries_come_out_in_date_order() -> None:
    out = b.build(_site(),
                  {"meetings": [{"date": "2026-12-01", "title": "Later"},
                                {"date": "2026-09-15", "title": "Earlier"}]},
                  {"events": []})
    assert out.index("Earlier") < out.index("Later")
