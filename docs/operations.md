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

Optional. `PATROL_PASSWORDS` is a JSON map of password → patrol slug:

```json
{ "some-password": "viper" }
```

That password can write `data/patrols/viper.json` and nothing else. Enforced in
the Worker, not the UI.

---

## The workflows

**`stamp.yml`** — after a push touching HTML or assets, rewrites every
`assets/…?v=` query string to the commit SHA and commits with `[skip stamp]`.
This is why a stylesheet change is never served stale, and why nobody has to
remember to bump a version number. The `[skip stamp]` marker is what stops it
triggering itself.

**`gcal-sync.yml`** — reconciles the schedule with the troop's Google Calendar
every fifteen minutes and after any push touching `data/`. See below. It is off
until `flags.gcalSync` is true, and skips its own commits by their
`[calendar sync]` marker.

**`backup.yml`** — nightly, validates every JSON file and copies `data/` onto a
`content-backup` branch. To recover: browse to that branch on GitHub, open the
file, copy it back. It refuses to snapshot data that fails to parse, so a broken
file cannot overwrite a good backup.

---

## Google Calendar

The site and the troop's Google Calendar are **two way**. An edit in the editor
reaches the calendar; an edit on the calendar comes back into `data/`. The
reconcile runs in GitHub Actions, not in the Worker, because it needs to read
Google as well as write it and it needs a service account key.

### What each side owns

The calendar only knows what a calendar can express: **title, when, where,
cancelled**. Those four round trip. Everything else — the summary, the patrol
tags, the attached files, the catch-up notes — lives only on the site, and the
sync never touches it. The event description on Google is generated from the
site each time and is not read back; editing it there does nothing.

**Deleting on Google Calendar does not delete anything here.** The sync never
deletes a record. To call something off, set its status to cancelled — either in
the editor or by cancelling the event on Google — and both sides will say
cancelled. This is on purpose: a calendar app makes deletion one click away, and
one stray click should not remove a campout from the website.

If the same entry is edited in both places between runs, **the more recent edit
wins**, judged by Google's `updated` timestamp against the site's last commit
time for that file.

### Turning it on

1. **Google Cloud.** Create a project, enable the **Google Calendar API**, then
   create a **service account** under IAM & Admin. Give it no roles. Make a
   **JSON key** and download it.
2. **Share the calendar with it.** In Google Calendar → the troop calendar →
   Settings and sharing → *Share with specific people* → add the service account
   address (`something@….iam.gserviceaccount.com`) with **Make changes to
   events**. This is the step everybody forgets; without it every write returns
   403.
3. **Make the calendar public** if you want the embed and the subscribe buttons
   to work for people who are not signed in: same settings page → *Access
   permissions* → **Make available to public**, "See all event details".
4. **Two repository secrets** (Settings → Secrets and variables → Actions):
   - `GCAL_CALENDAR_ID` — from *Integrate calendar → Calendar ID*, ending in
     `@group.calendar.google.com`.
   - `GCAL_SA_JSON` — the whole downloaded JSON key file, pasted in as is.
5. **In the editor**, under *Site details → Google Calendar*: paste the same
   calendar ID, tick **Keep Google Calendar in step with this schedule**, and
   publish. That writes `calendar.googleCalendarId` and `flags.gcalSync: true`
   into `data/site.json`.

The calendar ID is doing double duty: it is also what builds the embed, the
"Add to Google Calendar" button and the `.ics` link on `calendar.html`. One
field, four things — see `calendarLinks()` in `assets/site.js`.

### Checking it

Actions → **Google Calendar sync** → *Run workflow* has a **dry run** box. Tick
it and it will print every change it would make and write nothing, to either
side. Do that first. The unit tests (`scripts/test_gcal_sync.py`, 14 of them)
run as part of the same job and the sync is skipped if they fail.

### Switching it off

Untick the box in the editor, or set `flags.gcalSync` to `false` in
`data/site.json` by hand. The job still runs and immediately exits. Nothing
already on the calendar is removed; the two sides simply stop talking. Leadership
can do this without access to GitHub or to Google Cloud, which is the point.

### How it does not loop

Two guards. The workflow skips any push whose commit message contains
`[calendar sync]`, which is the message its own commits carry. And commits made
by `GITHUB_TOKEN` inside Actions do not trigger workflows at all, so the belt
and the braces are independent. On top of that each record stores
`gcalSyncedHash` — a digest of the four shared fields as of the last agreed
state — so a run that changes nothing writes nothing and makes no commit.

### `data/` fields the sync owns

`gcalEventId` (the Google event id) and `gcalSyncedHash`. Both are written by
the job and round-tripped by the editor. Do not edit them by hand. Clearing
`gcalEventId` makes the next run create a **second** copy on the calendar.

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
