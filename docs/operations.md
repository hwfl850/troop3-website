# Operations

For whoever maintains the site. If you only need to post a catch-up or add a
campout, read `editing-guide.md` instead — you never have to touch any of this.

---

## What this is

A static site. Plain HTML, one stylesheet, one script. No build step, no
framework, no node_modules, nothing to compile. What is in the repository is
what the browser gets.

```
/                 the pages, one .html per screen
/assets           styles.css, site.js, admin.js
/data             all editable content, as JSON
/data/patrols     one file per patrol, plus index.json
/files            PDFs
/img              logos, patrol emblems, trail images
/worker           the Cloudflare Worker that does the writing
/docs             this
/.github          two workflows
```

The pages read `/data/*.json` at load. To change what the site says, you change
JSON — through `admin.html`, or by editing the file directly if you prefer.

**The HTML is generated** by throwaway Python scripts that are deliberately not
in this repository. Nothing at runtime depends on them. Edit the HTML directly;
it is normal, readable HTML.

---

## Hosting

GitHub Pages, serving `main` from the repository root.

- **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**
- `.nojekyll` is present, which stops GitHub from running Jekyll over the files.
  Do not delete it.

A push to `main` is a deploy. It takes under a minute.

### Custom domain

The site is written assuming it lives at `https://troop3pensacola.org` — that
is what the canonical tags, `sitemap.xml`, and the Worker's `ALLOWED_ORIGINS`
say.

There is **deliberately no `CNAME` file in this repository.** Committing one for
a domain that is not pointed at GitHub yet takes the site *down*: GitHub would
start redirecting the working `*.github.io` URL to a hostname that does not
resolve.

To switch the custom domain on, in this order:

1. At the DNS registrar for `troop3pensacola.org`, add:
   - `A` records for the apex to `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
   - a `CNAME` for `www` to `<account>.github.io`
2. Wait for those to resolve (`dig troop3pensacola.org +short`).
3. **Settings → Pages → Custom domain**, enter the domain, save. GitHub creates
   the `CNAME` file itself.
4. Tick **Enforce HTTPS** once the certificate is issued (can take an hour).

If the domain is **not** being used, the site works fine at the
`*.github.io` URL, but three things should be corrected to match:
`SITE_URL`-derived canonical tags in the page `<head>`s, the URLs in
`sitemap.xml`, and `ALLOWED_ORIGINS` in `worker/wrangler.toml`.

---

## The write path

This is the only interesting part of the architecture.

```
admin.html  →  Cloudflare Worker  →  GitHub Contents API  →  main  →  Pages
 (browser)      (holds the token)
```

The browser never holds a GitHub token. It sends a password and a file to the
Worker; the Worker decides whether to commit. Every rule that matters is
enforced in the Worker, because that is the only side an editor cannot bypass.

The Worker will only:

- write paths matching an allow-list (`data/*.json`, `data/patrols/*.json`,
  uploads under `files/` and `img/uploads/`)
- write content that parses as JSON with an object at the top level
- write files that **already exist** — it cannot create new content files
- write a shrinking file only when the client explicitly confirms it
  (`confirmShrink`), where "shrinking" means losing more than 5 entries or
  more than 40% of them

Setup lives in `worker/README.md`. Short version:

```bash
cd worker
# edit wrangler.toml → GITHUB_REPO = "<account>/troop3-website"
npx wrangler secret put GITHUB_TOKEN     # fine-grained PAT
npx wrangler secret put EDIT_PASSWORD
npx wrangler deploy
```

Then put the deployed URL into `data/site.json` → `admin.workerUrl` and commit.
Until that field is set, the editor works but cannot publish.

### The token

Fine-grained PAT, **this repository only**, **Contents: read and write**,
nothing else. It expires; when it does, publishing fails with a clear message
and you issue a new one and re-run `wrangler secret put GITHUB_TOKEN`. Nothing
else in the system changes.

### Rotating the password

Two places, and it is broken in between, so do both in one sitting:

```bash
printf '%s' 'the-new-password' | shasum -a 256
```

1. Put that hash into the `ROLES` array at the top of `assets/admin.js` and push.
2. `cd worker && npx wrangler secret put EDIT_PASSWORD` with the plain password.

The hash in `admin.js` only decides whether the browser shows the editor. The
Worker's `EDIT_PASSWORD` is the check that actually protects anything — a hash
shipped to a browser is not a secret, and is not treated as one here.

### Patrol passwords

Optional. `PATROL_PASSWORDS` is a JSON map of password → what it covers. The
value is one patrol slug, a list of them, or `"*"` for every patrol:

```json
{
  "PLC27!": "*",
  "some-other-password": "viper",
  "a-third": ["viper", "flaming-arrow"]
}
```

`PLC27!` is the shared Patrol Leaders' Council password: it can write any
`data/patrols/<slug>.json`, and nothing else — not meetings, not events, not
the banner, not `data/patrols/index.json` (which decides what patrols exist),
and it cannot upload files. Enforced in the Worker, not the UI.

Each password also needs its SHA-256 in the `ROLES` array in `assets/admin.js`,
or the sign-in form rejects it before the Worker ever sees it. A role there
carries the tabs it may open: the PLC role gets `['patrols', 'help']`.

Setting or changing it:

```bash
cd worker
npx wrangler secret put PATROL_PASSWORDS
# paste the whole JSON map — it replaces the old one entirely
```

---

## The workflows

**`stamp.yml`** — after a push touching HTML or assets, rewrites every
`assets/…?v=` query string to the commit SHA and commits with `[skip stamp]`.
This is why a stylesheet change is never served stale, and why nobody has to
remember to bump a version number. The `[skip stamp]` marker is what stops it
triggering itself.

**`ics.yml`** — after a push touching `data/meetings.json`,
`data/events.json`, `data/site.json` or `scripts/build_ics.py`, rebuilds
`calendar.ics` and commits it if the bytes changed. See below. No schedule, no
secrets. It skips pushes authored by `github-actions[bot]`, which is who its
own commits are made as — the guard matches the commit *author* rather than the
message, so a commit that merely mentions the calendar is not skipped by
accident.

**`backup.yml`** — nightly, validates every JSON file and copies `data/` onto a
`content-backup` branch. To recover: browse to that branch on GitHub, open the
file, copy it back. It refuses to snapshot data that fails to parse, so a broken
file cannot overwrite a good backup.

---

## The calendar feed

The site publishes **its own** calendar at `/calendar.ics`, built from
`data/meetings.json` and `data/events.json` by `scripts/build_ics.py`. Families
subscribe to that address from Google Calendar, Apple Calendar or Outlook and
their copy keeps itself current.

The arrow only points one way. The site has no account on anybody's calendar,
no key, no token and no write access to anything, so there is nothing to
configure, nothing to leak, and no way for a bug here to change an event on
somebody else's phone — only what it shows of ours.

### What travels and what does not

A calendar app can hold **title, when, where, a description, a link, and
cancelled**. Those go out. The patrol tags, the packing lists, the attached
files and the run of show stay on the site, because a calendar app has nowhere
to put them; the description carries the summary and a link back to the page
that does.

**Cancelled entries stay in the feed**, as `STATUS:CANCELLED`, rather than
disappearing. A campout that silently vanishes from a phone tells a scout
nothing; one that says CANCELLED tells them the thing that matters. Delete the
record only when it should never have existed.

Anything a subscriber changes in their own copy is theirs. It never comes back
here, and the next refresh overwrites it.

### The subscribe links

There is nothing to paste. `calendarLinks()` in `assets/site.js` derives all
three buttons on `calendar.html` from `url` in `data/site.json`:

| Button | Where it points |
| --- | --- |
| Add to Google Calendar | `calendar.google.com/calendar/r?cid=` + the `webcal:` address |
| Apple / Outlook | `webcal://troop3pensacola.org/calendar.ics` |
| Download .ics | `https://troop3pensacola.org/calendar.ics` |

`webcal:` is what tells a calendar app to **subscribe** rather than to import a
snapshot; the plain `https:` link downloads a copy of today that then quietly
goes out of date, which is why it is the third button and not the first.
`safeHref()` allows `webcal:` for exactly this reason.

Set `icsHref`, `downloadHref`, `subscribeHref` or `embedHref` under `calendar`
in `data/site.json` only to override one of them.

### When it rebuilds

`ics.yml` runs on any push touching `data/meetings.json`, `data/events.json`,
`data/site.json` or the build script — so the feed is rewritten within a minute
or two of anyone publishing from the editor. There is no schedule and no cron,
because there is nothing to poll.

How quickly a *subscriber* sees it is up to their app. The file asks for a
twelve-hour refresh (`REFRESH-INTERVAL` and `X-PUBLISHED-TTL`), Apple and
Outlook roughly honour it, and Google decides for itself — a day is normal.
**Do not promise anyone fifteen minutes.** If something has to be known today,
send it; the calendar is for the shape of the year, not for urgent news.

### Checking it

Actions → **Build calendar.ics** → *Run workflow*. The job runs
`scripts/test_build_ics.py` (22 tests) first and will not build if they fail.
It commits `calendar.ics` only when the bytes actually changed, so a run that
finds nothing new leaves no commit.

To see it locally:

```bash
python3 scripts/build_ics.py     # writes calendar.ics, or says it is current
python3 -m pytest scripts -q
```

The build is deliberately **byte-for-byte repeatable**: `DTSTAMP` comes from
each record's own `updated` field rather than from the clock, so running it
twice produces the same file and the history does not fill up with commits that
changed nothing.

### Things in the file that look odd but are load-bearing

- **All-day `DTEND` is the morning after the last day.** RFC 5545 makes it
  exclusive. A three-day campout ending the 30th writes `20260831`. Getting
  this wrong shows every campout a day short.
- **Everything is written in UTC.** That is why there is no `VTIMEZONE` block.
  `zoneinfo` picks the right offset per date, so a July meeting lands at
  `23:30Z` and the same December meeting at `00:30Z` the next day.
- **Lines fold at 75 *octets*, not characters**, with a single leading space on
  each continuation, and never in the middle of a multi-byte character. Some
  clients reject a file that splits one.
- **The `X-WR-*` properties are not escaped.** They are not RFC properties and
  clients print them raw, so an escaped comma would show up on screen as
  `Troop 3 Pensacola\, Florida`.

### There is no Google credential

There used to be a two-way sync with a service account key, `gcal_sync.py`. It
is gone, along with the key, the two repository secrets, the conflict
resolution, the kill switch and the `gcalEventId` / `gcalSyncedHash` fields on
every record. If you find a reference to any of those, it is stale — delete it.

## Things that will look like bugs but are not

**A blank middle of the page.** Each page ships its heading and layout as static
HTML and only swaps the middle section. If data fails to load you get a visible
"could not load" panel, not a plausible-looking wrong page. That is deliberate:
the failure mode of a data-driven site is showing stale or empty content as if
it were true.

**Defaults that look obviously empty.** Where a value is missing, the site shows
a structural placeholder rather than a guess. Better to look unfinished than to
be confidently wrong about when a meeting is.

**The editor refusing to publish.** See the shrink guard above. It is doing its
job.

---

## Local preview

```bash
cd site
python3 -m http.server 8000
```

Then http://localhost:8000. `file://` will not work — the pages fetch JSON, and
that needs a real origin.
