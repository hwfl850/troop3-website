# Troop 3 Pensacola

The website for Scouts BSA Troop 3, Pensacola, Florida — chartered 1937.

**Live:** https://troop3pensacola.org

## For leadership

To post a catch-up, add a campout, or cancel a meeting, go to
**[/admin.html](https://troop3pensacola.org/admin.html)** and type the password.
That is the whole workflow — you never need this repository.

The guide is [`docs/editing-guide.md`](docs/editing-guide.md). It is three
minutes long and assumes you have never seen code.

## For whoever maintains it

A static site: plain HTML, one stylesheet, one script, no build step. GitHub
Pages serves `main` from the root, so a push is a deploy.

All content lives in `/data/*.json` and is read by the pages at load. Writes go
through a Cloudflare Worker that holds the GitHub token — the browser never
does.

```
/            pages          /data     content (JSON)
/assets      css + js       /files    PDFs
/worker      write path     /img      logos, emblems, trail images
/scripts     calendar sync  /.github  stamp, backup, calendar sync
/docs        the docs
```

The schedule is kept in step with the troop's Google Calendar both ways, by a
GitHub Action rather than by the Worker — `scripts/gcal_sync.py`. Title, date,
time, place and cancellation cross over; nothing else does, and nothing is ever
deleted.

Everything else — hosting, the custom domain, the Worker, the token, password
rotation, and setting up the calendar sync — is in
[`docs/operations.md`](docs/operations.md).

## Local preview

```bash
python3 -m http.server 8000
```

http://localhost:8000. `file://` will not work; the pages fetch JSON.

## Two rules

1. **No youth full names, ever.** First name and last initial. No home
   addresses, no youth phone numbers or emails.
2. **Cancel, don't delete.** A cancelled meeting stays on the schedule with a
   badge, so a Scout who shows up anyway finds out why.
