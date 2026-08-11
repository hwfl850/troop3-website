# Editing the Troop 3 site

You do not need to know anything about code, and you cannot break the site by
using this page. Everything happens at:

**https://troop3pensacola.org/admin.html**

Type the password. The page opens. Make changes. Press **Publish**. The site
updates in about a minute.

---

## The one thing that matters most

**Post a catch-up after every meeting.**

A catch-up is two or three sentences saying what the troop actually did that
night, plus anything a Scout who missed it needs to know. Half the people who
open this site are trying to find out what they missed. Nothing else on the site
does that job.

It is the first panel on the editor page for that reason. It takes one minute:

1. Open **admin.html**, type the password.
2. The **Post a catch-up** box is already pointed at the most recent meeting
   that does not have one.
3. Write what happened.
4. Press **Publish**.

Do not worry about polish. "Worked on knots for Tenderfoot, finished planning
for the Blackwater trip. Bring your permission slip next week." is a good
catch-up. A blank one is not.

---

## The panels

### Post a catch-up
One box. Picks the meeting for you; you can change which meeting from the
dropdown if you are writing one late.

### Meetings
Add, edit, or cancel a meeting night.

- **Date** — the Tuesday it happens.
- **Topic** — what the night is about ("Knife and axe safety").
- **Summary** — one line shown in the schedule list.
- **Bring with you** — one item per line. Shows as a checklist.
- **Status** — `scheduled`, `cancelled`, or `moved`. Cancelling never deletes
  the meeting; it stays on the schedule with a red badge so people who show up
  anyway understand why. **Cancel, do not delete.**
- **Duplicate** copies a meeting to the next Tuesday, which is the fastest way
  to fill in a month.

### Events
Campouts, service projects, courts of honor, summer camp. Same idea as
meetings, but events can span several days — fill in **End date** as well.
`cost`, `deadline`, and `signupHref` show up on the event page when set.

### Patrols
Each patrol has its own page: members, leadership, what they are working on.
A patrol leader can be given their own password that edits only their patrol's
page and nothing else — see `docs/operations.md`.

### Banner & site
The banner is the strip across the top of every page. Use it for the one thing
you want everybody to see this month, and **take it down when it is stale** — a
banner about a trip that already happened teaches people to ignore banners.

Meeting time, meeting place, contact email, and the numbers on the home page
live here too.

---

## Publishing

The **Publish** bar appears at the bottom as soon as you change anything. It
lists which files changed. Press **Show changes** to see exactly what will be
written, line by line, before you commit to it.

Press **Publish**. It writes each file one at a time and tells you what
happened. Give the site about a minute, then reload.

If you close the tab without publishing, your changes are gone. Nothing is
saved until you press Publish.

---

## The safety nets

You are going to be nervous about wrecking something. Don't be — here is what
stops that.

**A failed load blocks the save.** If the editor cannot read the current
schedule (bad wifi, GitHub having a bad day), it will not let you publish over
it. It says so in red at the top. Reload the page and try again.

**A big deletion needs confirmation.** If a save would remove more than five
entries, or more than 40% of them, both the editor *and* the server stop and
ask whether you meant it. Deliberate cleanup: say yes. Surprise: say no, and
reload.

**Everything is recoverable.** Every publish is a separate commit in the
repository, and the content is copied to a backup branch nightly. Nothing is
ever really lost — worst case, ask whoever maintains the site to roll back.

---

## Rules about names

- **Never publish a youth's full name.** First name and last initial. This is
  the one hard rule on the site.
- **Never publish a home address**, a youth phone number, or a youth email.
- Adult leaders: first name and last initial, and the troop email address —
  not personal ones.
- The Eagle roster is the one exception people ask about. It uses first name
  and last initial too, and there is a switch to turn the roster off entirely.

---

## If something is wrong

- **The page says "could not load".** Reload. If it keeps happening, the site's
  content files may be unreachable — do not publish, ask for help.
- **Publish says "not configured".** The Worker URL is missing from
  `data/site.json`. See `docs/operations.md`.
- **The password stopped working.** Somebody rotated it. It has to be changed in
  two places (see operations), so a half-finished rotation looks exactly like
  this.
- **You published something wrong.** Publish the correction. It is a website,
  not a launch code.
