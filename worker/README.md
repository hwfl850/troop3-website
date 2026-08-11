# The content Worker

This is the only thing that can write to the site. The editor in the browser
sends it a password and a new file; it checks both and commits to GitHub.

The GitHub token lives here as a Cloudflare secret and never reaches a browser.

## Deploying it

You need a Cloudflare account (the free plan is plenty) and Node installed.

```bash
cd site/worker

# 1. Point it at the repository
#    edit wrangler.toml → GITHUB_REPO = "your-account/troop3-website"

# 2. Give it its secrets
npx wrangler secret put GITHUB_TOKEN       # paste the fine-grained PAT
npx wrangler secret put EDIT_PASSWORD      # the leadership password
npx wrangler secret put PATROL_PASSWORDS   # optional — see below

# 3. Ship it
npx wrangler deploy
```

Wrangler prints a URL like `https://troop3-content.<account>.workers.dev`.
Put that URL into `site/data/site.json` under `admin.workerUrl` and commit it.
Until that field is filled in, the editor stages changes but cannot publish.

## The token

Make a **fine-grained** personal access token on GitHub:

- Repository access: **only** this repository
- Permissions: **Contents → Read and write**. Nothing else.
- Expiry: whatever you are willing to renew. Put a reminder in the troop calendar.

When it expires, publishing stops working with a clear error and you generate a
new one and re-run `wrangler secret put GITHUB_TOKEN`. Nothing else changes.

## Passwords

`EDIT_PASSWORD` is the Scoutmaster / committee password. It can edit every
content file.

`PATROL_PASSWORDS` is optional and lets a patrol leader edit their own patrol
page and nothing else:

```json
{ "some-viper-password": "viper", "some-flaming-arrow-password": "flaming-arrow" }
```

A patrol password can only write `data/patrols/<their-slug>.json`. The Worker
checks that on every request — it is not a UI restriction.

If you change `EDIT_PASSWORD`, also update the SHA-256 hash at the top of
`site/assets/admin.js`, which is what decides whether the browser shows the
editor at all. The Worker is the check that matters; the hash just stops the
form appearing for people who guessed wrong.

To compute the new hash:

```bash
printf '%s' 'the-new-password' | shasum -a 256
```

## What it will and will not do

- Writes only the JSON files under `data/`, plus uploads to `files/` and
  `img/uploads/`. Any other path is rejected before anything else happens.
- Rejects content that is not valid JSON, or whose top level is not an object.
- **Refuses a save that would remove a lot of entries** — more than five, or
  more than 40% of them — unless the editor confirms it deliberately. This is
  the guard against a browser that failed to read the current file and is about
  to publish an empty one over it.
- Refuses to create content files that do not already exist.
- Returns a plain error and commits nothing if GitHub rejects the write.

## Endpoints

| Method | Path       | What it does                                       |
|--------|------------|----------------------------------------------------|
| `GET`  | `/health`  | Liveness check                                     |
| `GET`  | `/content` | Current content of an allowed path, straight from GitHub |
| `POST` | `/save`    | Validate, guard, and commit a content file          |
| `POST` | `/upload`  | Commit a PDF or image                               |

## Google Calendar

Not wired up. `pushToGoogleCalendar()` in `index.js` is a stub that returns
immediately. Every meeting and event already carries an empty `gcalEventId`
field, so when it is switched on the schedule does not have to be re-entered.

When it is built, it belongs **here**, in the Worker, with a Google service
account — not in the browser, which cannot hold a credential.
