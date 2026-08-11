/* ══════════════════════════════════════════════════════════════════════════
   Troop 3 — leadership editor
   ─────────────────────────────────────────────────────────────────────────
   Loads the live content files, lets leadership edit them, and publishes the
   result through the troop's Worker, which holds the GitHub token and does
   the committing. Nothing here can write anything on its own.

   The password check in this file only decides what the browser will show.
   The check that matters happens in the Worker, on every single save.

   Saving is deliberately hard to do wrong:
     · a file that failed to load can never be saved over  (loadState)
     · a save that shrinks a file a lot has to be confirmed (wipeCheck)
     · the Worker repeats both checks and refuses on its own authority
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* SHA-256 of the leadership password. Changing the password means changing
     this hash *and* the secret in the Worker — the Worker is the real gate. */
  var ROLES = [
    { hash: '79edbc24996492781064ede4a496c25e8dc5264a195ddfd5ecdbdad93e14de4f',
      label: 'Scoutmaster / committee', scope: '*' }
  ];

  var PW_KEY = 't3.admin.pw';        // sessionStorage: cleared when the tab closes
  var ROLE_KEY = 't3.admin.role';

  var E, el, show, hide, esc;
  var session = null;                 // { label, scope, password }
  var files = {};                     // id → { path, state, data, original }
  var dirty = {};                     // id → true
  var patrolSlugs = [];

  /* ────────────────────────────────────────────────────────── boot ─────── */

  window.onSiteReady = function () {
    E = window.T3;
    el = E.el; show = E.show; hide = E.hide; esc = E.esc;

    bindGate();
    bindTabs();
    bindSaveBar();

    var pw = sessionRead();
    if (pw) unlock(pw.role, pw.password);
  };

  /* ───────────────────────────────────────────────────── sign in ───────── */

  function bindGate() {
    el('gate-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var pw = el('gate-pw').value;
      sha256(pw).then(function (h) {
        var role = null;
        ROLES.forEach(function (r) { if (r.hash === h) role = r; });
        if (!role) { show('gate-error'); el('gate-pw').select(); return; }
        hide('gate-error');
        sessionWrite(role, pw);
        unlock(role, pw);
      });
    });

    el('sign-out').addEventListener('click', function () {
      if (Object.keys(dirty).length &&
          !confirm('You have staged changes that have not been published. Sign out anyway?')) return;
      try { sessionStorage.removeItem(PW_KEY); sessionStorage.removeItem(ROLE_KEY); } catch (e) { /* ignore */ }
      location.reload();
    });
  }

  function sessionWrite(role, pw) {
    try {
      sessionStorage.setItem(PW_KEY, pw);
      sessionStorage.setItem(ROLE_KEY, role.hash);
    } catch (e) { /* private mode — the session just will not survive a refresh */ }
  }

  function sessionRead() {
    try {
      var pw = sessionStorage.getItem(PW_KEY), h = sessionStorage.getItem(ROLE_KEY);
      if (!pw || !h) return null;
      var role = null;
      ROLES.forEach(function (r) { if (r.hash === h) role = r; });
      return role ? { role: role, password: pw } : null;
    } catch (e) { return null; }
  }

  function unlock(role, password) {
    session = { label: role.label, scope: role.scope, password: password };
    hide('gate');
    show('console');
    el('who').textContent = role.label;
    bindConsoleOnce();
    loadEverything();
  }

  /* Handlers that must survive re-renders are bound exactly once. */
  function bindConsoleOnce() {
    el('m-add').addEventListener('click', addMeeting);
    el('m-dup').addEventListener('click', duplicateMeeting);
    el('e-add').addEventListener('click', addEvent);
    el('cu-meeting').addEventListener('change', fillCatchUpText);
    el('cu-apply').addEventListener('click', applyCatchUp);
  }

  /* ─────────────────────────────────────────────────── loading ─────────── */

  function register(id, path) {
    files[id] = { path: path, state: 'pending', data: null, original: '' };
  }

  function loadEverything() {
    register('meetings', 'data/meetings.json');
    register('events', 'data/events.json');
    register('site', 'data/site.json');
    register('patrolIndex', 'data/patrols/index.json');

    var jobs = [load('meetings'), load('events'), load('site'), load('patrolIndex')];

    Promise.all(jobs).then(function () {
      patrolSlugs = ((files.patrolIndex.data || {}).patrols || []).map(function (p) { return p.slug; });
      var more = patrolSlugs.map(function (s) {
        register('patrol:' + s, 'data/patrols/' + s + '.json');
        return load('patrol:' + s);
      });
      return Promise.all(more);
    }).then(function () {
      reportLoad();
      renderCatchUp();
      renderMeetings();
      renderEvents();
      renderPatrols();
      renderSite();
    });
  }

  /* Reads the live file. A 404 or a network error is a *failure*, never an
     empty file — that distinction is the whole reason this console cannot
     quietly replace real content with nothing. */
  function load(id) {
    var f = files[id];
    return E.loadJSON(f.path).then(function (d) {
      f.data = d;
      f.original = stringify(d);
      f.state = 'ok';
    }).catch(function (err) {
      f.state = 'failed';
      if (window.console) console.error('[T3 admin] could not load ' + f.path, err);
    });
  }

  function reportLoad() {
    var bad = Object.keys(files).filter(function (k) { return files[k].state !== 'ok'; });
    var host = el('load-status');
    if (!bad.length) { host.innerHTML = ''; return; }
    host.innerHTML =
      '<div class="notice notice-error"><strong>Some content could not be loaded.</strong> ' +
      'Saving is blocked for: ' + bad.map(function (k) { return esc(files[k].path); }).join(', ') +
      '. Refresh the page. If it keeps happening, do not try to work around it — ' +
      'publishing over a file that failed to load is how a site gets wiped.</div>';
  }

  function canSave(id) { return files[id] && files[id].state === 'ok'; }

  /* ──────────────────────────────────────────────────── tabs ───────────── */

  function bindTabs() {
    var btns = document.querySelectorAll('.admin-nav button');
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        var tab = b.getAttribute('data-tab');
        btns.forEach(function (o) { o.setAttribute('aria-current', String(o === b)); });
        document.querySelectorAll('[data-panel]').forEach(function (p) {
          p.classList.toggle('is-hidden', p.getAttribute('data-panel') !== tab);
        });
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
    });
  }

  /* ─────────────────────────────────────── panel: post a catch-up ──────── */

  function renderCatchUp() {
    var sel = el('cu-meeting');
    if (!canSave('meetings')) {
      sel.innerHTML = '<option>Meetings could not be loaded</option>';
      sel.disabled = true;
      el('cu-apply').disabled = true;
      return;
    }
    var t = E.today();
    var list = (files.meetings.data.meetings || []).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : -1;                       // newest first
    });

    sel.innerHTML = list.map(function (m) {
      var flag = m.catchUp ? ' — catch-up posted' : (m.date < t ? ' — nothing posted yet' : ' — upcoming');
      return '<option value="' + esc(m.date) + '">' +
             esc(E.fmtDate(m.date, 'numeric') + ' · ' + (m.title || 'Meeting') + flag) + '</option>';
    }).join('');

    /* Default to the most recent past meeting with no catch-up yet — that is
       almost always the one being written. If every past meeting already has
       one, fall back to the most recent past meeting rather than to the top of
       the list, which is a meeting months from now. */
    var target = null, lastPast = null;
    list.forEach(function (m) {
      if (m.date >= t) return;
      if (!lastPast) lastPast = m;
      if (!target && !m.catchUp) target = m;
    });
    target = target || lastPast;
    if (target) sel.value = target.date;
    fillCatchUpText();
  }

  function applyCatchUp() {
    var m = findMeeting(el('cu-meeting').value);
    if (!m) return;
    m.catchUp = el('cu-text').value.trim();
    if (!m.catchUp) delete m.catchUp;
    if (m.date < E.today() && (m.status || 'scheduled') === 'scheduled') m.status = 'happened';
    touch('meetings');
    renderMeetings();
    renderCatchUp();
    flash('Catch-up staged. Press Publish to put it on the site.');
  }

  function fillCatchUpText() {
    var m = findMeeting(el('cu-meeting').value);
    el('cu-text').value = (m && m.catchUp) || '';
  }

  function findMeeting(date) {
    var out = null;
    ((files.meetings.data || {}).meetings || []).forEach(function (m) {
      if (m.date === date) out = m;
    });
    return out;
  }

  /* ──────────────────────────────────────────── panel: meetings ────────── */

  var UNIFORMS = [['', '(troop default)'], ['field', 'Class A — field'],
                  ['activity', 'Class B — activity'], ['none', 'No uniform']];
  var STATUSES = [['scheduled', 'Scheduled'], ['happened', 'Happened'],
                  ['cancelled', 'Cancelled'], ['moved', 'Time or place changed']];

  function renderMeetings() {
    var host = el('m-list');
    if (!canSave('meetings')) {
      host.innerHTML = '<div class="notice notice-error">Meetings could not be loaded, so they cannot be edited.</div>';
      el('m-add').disabled = el('m-dup').disabled = true;
      return;
    }
    var list = (files.meetings.data.meetings || []).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : -1;
    });
    host.innerHTML = list.map(function (m) {
      return '<div class="editor-row">' +
        '<span class="er-date">' + esc(m.date) + '</span>' +
        '<span class="er-title">' + esc(m.title || '(no title)') + '</span>' +
        (E.statusBadge(m.status) || '') +
        (m.catchUp ? '<span class="badge badge-quiet">catch-up</span>' : '') +
        '<span class="er-actions">' +
          '<button class="btn btn-outline btn-sm" type="button" data-edit="' + esc(m.date) + '">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-del="' + esc(m.date) + '">Delete</button>' +
        '</span>' +
      '</div>';
    }).join('') || '<p style="color:var(--text-muted)">No meetings yet.</p>';

    host.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { meetingForm(findMeeting(b.getAttribute('data-edit'))); });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = b.getAttribute('data-del');
        if (!confirm('Delete the meeting on ' + d + '? Cancelling it is usually better than deleting it.')) return;
        files.meetings.data.meetings = files.meetings.data.meetings.filter(function (m) { return m.date !== d; });
        touch('meetings');
        renderMeetings(); renderCatchUp();
      });
    });
  }

  function meetingForm(m) {
    if (!m) return;
    var host = el('m-form');
    host.innerHTML =
      '<div class="sidebar-card" style="margin-top:1.5rem">' +
        '<h3>Editing ' + esc(E.fmtDate(m.date, 'long')) + '</h3>' +
        row(
          fld('Date', 'f-date', 'date', m.date) +
          fld('Title', 'f-title', 'text', m.title || '')
        ) +
        row(
          sel_('Status', 'f-status', STATUSES, m.status || 'scheduled') +
          sel_('Uniform', 'f-uniform', UNIFORMS, m.uniform || '')
        ) +
        row(
          fld('Start', 'f-start', 'time', m.start || '', 'Blank = the usual troop time') +
          fld('End', 'f-end', 'time', m.end || '')
        ) +
        fld('Where', 'f-loc', 'text', m.location || '', 'Blank = the Scout Hut') +
        area('One-line summary', 'f-summary', m.summary || '', 2, 'Shows on the program year and the home page.') +
        area('Catch-up — what actually happened', 'f-catchup', m.catchUp || '', 4,
             'For Scouts who were not there. Two or three sentences is plenty.') +
        area('Bring with you', 'f-bring', (m.bringWith || []).join('\n'), 3, 'One per line.') +
        area('Run of show', 'f-run', (m.runOfShow || []).map(function (r) {
          return [r.time || '', r.item || '', r.who || ''].join(' | ');
        }).join('\n'), 4, 'One per line: time | what | who. E.g. 18:45 | Knots relay | Viper') +
        area('Files and handouts', 'f-mats', (m.materials || []).map(function (x) {
          return (x.label || '') + ' | ' + (x.href || '');
        }).join('\n'), 3, 'One per line: label | link. Links to files already uploaded to /files/.') +
        patrolChecks(m.patrols || []) +
        area('Status note', 'f-statusnote', m.statusNote || '', 2, 'Only shown when cancelled or changed.') +
        '<div class="pill-row" style="margin-top:1rem">' +
          '<button class="btn btn-primary btn-sm" type="button" id="f-save">Stage this meeting</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" id="f-cancel">Close</button>' +
        '</div>' +
      '</div>';
    show(host);
    host.scrollIntoView({ block: 'nearest' });

    el('f-cancel').addEventListener('click', function () { hide(host); });
    el('f-save').addEventListener('click', function () {
      var newDate = el('f-date').value;
      if (!newDate) { alert('A meeting needs a date.'); return; }
      m.date = newDate;
      m.title = el('f-title').value.trim();
      setOrDrop(m, 'status', el('f-status').value, 'scheduled');
      setOrDrop(m, 'uniform', el('f-uniform').value, '');
      setOrDrop(m, 'start', el('f-start').value, '');
      setOrDrop(m, 'end', el('f-end').value, '');
      setOrDrop(m, 'location', el('f-loc').value.trim(), '');
      setOrDrop(m, 'summary', el('f-summary').value.trim(), '');
      setOrDrop(m, 'catchUp', el('f-catchup').value.trim(), '');
      setOrDrop(m, 'statusNote', el('f-statusnote').value.trim(), '');
      m.bringWith = lines(el('f-bring').value);
      if (!m.bringWith.length) delete m.bringWith;
      m.runOfShow = lines(el('f-run').value).map(function (l) {
        var p = l.split('|');
        return { time: (p[0] || '').trim(), item: (p[1] || '').trim(), who: (p[2] || '').trim() };
      });
      if (!m.runOfShow.length) delete m.runOfShow;
      m.materials = pairs(el('f-mats').value);
      if (!m.materials.length) delete m.materials;
      m.patrols = checked('mp-');
      if (!m.patrols.length) delete m.patrols;
      if (typeof m.gcalEventId !== 'string') m.gcalEventId = '';

      files.meetings.data.meetings.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      touch('meetings');
      hide(host);
      renderMeetings(); renderCatchUp();
      flash('Meeting staged.');
    });
  }

  function patrolChecks(selected) {
    var ps = (files.patrolIndex.data || {}).patrols || [];
    if (!ps.length) return '';
    return '<div class="field"><span class="field-label">Patrols this is for</span>' +
      '<div class="pill-row">' + ps.map(function (p) {
        var id = 'mp-' + p.slug;
        return '<label style="display:inline-flex;gap:.4rem;align-items:center;font-weight:600">' +
          '<input type="checkbox" id="' + esc(id) + '" value="' + esc(p.slug) + '" style="width:auto"' +
          (selected.indexOf(p.slug) > -1 ? ' checked' : '') + ' /> ' + esc(p.name || p.slug) +
        '</label>';
      }).join('') + '</div>' +
      '<p class="field-hint">Leave all of them unticked for a whole-troop meeting.</p></div>';
  }

  function checked(prefix) {
    var out = [];
    document.querySelectorAll('input[type=checkbox][id^="' + prefix + '"]').forEach(function (c) {
      if (c.checked) out.push(c.value);
    });
    return out;
  }

  /* Add / duplicate. Nothing is written to the file until "Stage" is pressed —
     but the new entry lives in the in-memory list from here on, so cancelling
     out of the form leaves an empty-titled meeting the editor can delete. */
  function addMeeting() {
    if (!canSave('meetings')) return;
    var m = { date: nextTuesday(), title: '', gcalEventId: '' };
    files.meetings.data.meetings.push(m);
    files.meetings.data.meetings.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    meetingForm(m);
  }

  function duplicateMeeting() {
    if (!canSave('meetings')) return;
    var list = files.meetings.data.meetings;
    if (!list.length) { alert('There is nothing to duplicate yet.'); return; }
    var last = list.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).pop();
    var copy = JSON.parse(JSON.stringify(last));
    copy.date = plusDays(last.date, 7);
    copy.gcalEventId = '';
    delete copy.catchUp;
    delete copy.status;
    list.push(copy);
    list.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    meetingForm(copy);
  }

  function nextTuesday() {
    var d = E.parseISO(E.today());
    do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 2);
    return isoOf(d);
  }

  function plusDays(iso, n) {
    var d = E.parseISO(iso);
    if (!d) return E.today();
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }

  function isoOf(d) {
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
  }

  /* ────────────────────────────────────────────── panel: events ────────── */

  var KINDS = [['campout', 'Campout'], ['summer-camp', 'Summer camp'],
               ['court-of-honor', 'Court of Honor'], ['oa', 'Order of the Arrow'],
               ['service', 'Service'], ['other', 'Other']];

  function renderEvents() {
    var host = el('e-list');
    if (!canSave('events')) {
      host.innerHTML = '<div class="notice notice-error">Events could not be loaded, so they cannot be edited.</div>';
      el('e-add').disabled = true;
      return;
    }
    var list = (files.events.data.events || []).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : -1;
    });
    host.innerHTML = list.map(function (e) {
      return '<div class="editor-row">' +
        '<span class="er-date">' + esc(e.date) + '</span>' +
        '<span class="er-title">' + esc(e.title || '(no title)') + '</span>' +
        '<span class="badge badge-quiet">' + esc(E.KIND[e.kind] || 'Event') + '</span>' +
        (E.statusBadge(e.status) || '') +
        '<span class="er-actions">' +
          '<button class="btn btn-outline btn-sm" type="button" data-eedit="' + esc(e.slug) + '">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-edel="' + esc(e.slug) + '">Delete</button>' +
        '</span>' +
      '</div>';
    }).join('') || '<p style="color:var(--text-muted)">No events yet.</p>';

    host.querySelectorAll('[data-eedit]').forEach(function (b) {
      b.addEventListener('click', function () { eventForm(findEvent(b.getAttribute('data-eedit'))); });
    });
    host.querySelectorAll('[data-edel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-edel');
        if (!confirm('Delete this event? Cancelling it is usually better than deleting it.')) return;
        files.events.data.events = files.events.data.events.filter(function (e) { return e.slug !== s; });
        touch('events');
        renderEvents();
      });
    });
  }

  function findEvent(slug) {
    var out = null;
    ((files.events.data || {}).events || []).forEach(function (e) { if (e.slug === slug) out = e; });
    return out;
  }

  function eventForm(e) {
    if (!e) return;
    var host = el('e-form');
    host.innerHTML =
      '<div class="sidebar-card" style="margin-top:1.5rem">' +
        '<h3>Editing ' + esc(e.title || 'new event') + '</h3>' +
        fld('Title', 'g-title', 'text', e.title || '') +
        fld('Link name (slug)', 'g-slug', 'text', e.slug || '', 'Lower case, hyphens, no spaces. Changing it breaks old links.') +
        row(
          sel_('Kind', 'g-kind', KINDS, e.kind || 'campout') +
          sel_('Status', 'g-status', STATUSES, e.status || 'scheduled')
        ) +
        row(
          fld('First day', 'g-date', 'date', e.date || '') +
          fld('Last day', 'g-end', 'date', e.endDate || '', 'Blank for a single day.')
        ) +
        row(
          fld('Leave at', 'g-dep', 'time', e.departure || '') +
          fld('Back at', 'g-ret', 'time', e.returnTime || '')
        ) +
        fld('Where', 'g-loc', 'text', e.location || '') +
        row(
          fld('Cost', 'g-cost', 'text', e.cost || '', 'E.g. $20 per Scout') +
          fld('Sign up by', 'g-deadline', 'date', e.signupDeadline || '')
        ) +
        fld('Drivers needed', 'g-drivers', 'number', e.driversNeeded || '') +
        sel_('Uniform', 'g-uniform', UNIFORMS, e.uniform || '') +
        area('One-line summary', 'g-summary', e.summary || '', 2) +
        area('Full description', 'g-desc', e.description || '', 5) +
        area('Packing list', 'g-pack', (e.packingList || []).join('\n'), 4, 'One per line.') +
        area('Files and forms', 'g-mats', (e.materials || []).map(function (x) {
          return (x.label || '') + ' | ' + (x.href || '');
        }).join('\n'), 3, 'One per line: label | link.') +
        area('Status note', 'g-statusnote', e.statusNote || '', 2) +
        '<div class="pill-row" style="margin-top:1rem">' +
          '<button class="btn btn-primary btn-sm" type="button" id="g-save">Stage this event</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" id="g-cancel">Close</button>' +
        '</div>' +
      '</div>';
    show(host);
    host.scrollIntoView({ block: 'nearest' });

    el('g-cancel').addEventListener('click', function () { hide(host); });
    el('g-save').addEventListener('click', function () {
      var slug = slugify(el('g-slug').value || el('g-title').value);
      if (!slug) { alert('An event needs a link name.'); return; }
      if (!el('g-date').value) { alert('An event needs a first day.'); return; }
      var clash = findEvent(slug);
      if (clash && clash !== e) { alert('Another event already uses the link name "' + slug + '".'); return; }

      e.slug = slug;
      e.title = el('g-title').value.trim();
      e.kind = el('g-kind').value;
      setOrDrop(e, 'status', el('g-status').value, 'scheduled');
      e.date = el('g-date').value;
      setOrDrop(e, 'endDate', el('g-end').value, '');
      setOrDrop(e, 'departure', el('g-dep').value, '');
      setOrDrop(e, 'returnTime', el('g-ret').value, '');
      setOrDrop(e, 'location', el('g-loc').value.trim(), '');
      setOrDrop(e, 'cost', el('g-cost').value.trim(), '');
      setOrDrop(e, 'signupDeadline', el('g-deadline').value, '');
      setOrDrop(e, 'uniform', el('g-uniform').value, '');
      setOrDrop(e, 'summary', el('g-summary').value.trim(), '');
      setOrDrop(e, 'description', el('g-desc').value.trim(), '');
      setOrDrop(e, 'statusNote', el('g-statusnote').value.trim(), '');
      var dr = parseInt(el('g-drivers').value, 10);
      if (dr > 0) e.driversNeeded = dr; else delete e.driversNeeded;
      e.packingList = lines(el('g-pack').value);
      if (!e.packingList.length) delete e.packingList;
      e.materials = pairs(el('g-mats').value);
      if (!e.materials.length) delete e.materials;
      if (typeof e.gcalEventId !== 'string') e.gcalEventId = '';

      files.events.data.events.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      touch('events');
      hide(host);
      renderEvents();
      flash('Event staged.');
    });
  }

  function addEvent() {
    if (!canSave('events')) return;
    var e = { slug: '', title: '', kind: 'campout', date: E.today(), gcalEventId: '' };
    files.events.data.events.push(e);
    eventForm(e);
  }

  /* ───────────────────────────────────────────── panel: patrols ────────── */

  function renderPatrols() {
    var pick = el('p-pick');
    var ps = ((files.patrolIndex.data || {}).patrols || []).filter(function (p) {
      return session.scope === '*' || session.scope === p.slug;
    });
    if (!ps.length) {
      el('p-form').innerHTML = '<div class="notice notice-error">No patrol is available to edit.</div>';
      return;
    }
    pick.innerHTML = ps.map(function (p) {
      return '<option value="' + esc(p.slug) + '">' + esc(p.name || p.slug) + '</option>';
    }).join('');
    pick.addEventListener('change', function () { patrolForm(pick.value); });
    patrolForm(pick.value);
  }

  function patrolForm(slug) {
    var id = 'patrol:' + slug;
    var host = el('p-form');
    if (!canSave(id)) {
      host.innerHTML = '<div class="notice notice-error">That patrol file could not be loaded, so it cannot be edited.</div>';
      return;
    }
    var p = files[id].data;
    var lead = p.leadership || {};

    host.innerHTML =
      '<div class="sidebar-card">' +
        '<h3>' + esc(p.name || slug) + '</h3>' +
        area('About the patrol', 'q-about', p.about || '', 4) +
        fld('Patrol yell', 'q-yell', 'text', p.yell || '') +
        '<p class="field-label" style="margin-top:1rem">Patrol leadership</p>' +
        row(
          fld('Patrol Leader', 'q-pl', 'text', lead.pl || '') +
          fld('Assistant PL', 'q-apl', 'text', lead.apl || '')
        ) +
        row(
          fld('Scribe', 'q-scribe', 'text', lead.scribe || '') +
          fld('Quartermaster', 'q-qm', 'text', lead.quartermaster || '')
        ) +
        area('Roster', 'q-roster', (p.roster || []).join('\n'), 6,
             'One per line. First name and last initial only — this page is public.') +
        area('Goals and notes', 'q-goals', textBlock(p, 'Our goals this year'), 4,
             'Appears on the patrol page under "Our goals this year".') +
        '<div class="pill-row" style="margin-top:1rem">' +
          '<button class="btn btn-primary btn-sm" type="button" id="q-save">Stage this patrol</button>' +
        '</div>' +
      '</div>';

    el('q-save').addEventListener('click', function () {
      p.about = el('q-about').value.trim();
      setOrDrop(p, 'yell', el('q-yell').value.trim(), '');
      p.leadership = {};
      addIf(p.leadership, 'pl', el('q-pl').value.trim());
      addIf(p.leadership, 'apl', el('q-apl').value.trim());
      addIf(p.leadership, 'scribe', el('q-scribe').value.trim());
      addIf(p.leadership, 'quartermaster', el('q-qm').value.trim());
      p.roster = lines(el('q-roster').value);
      setTextBlock(p, 'Our goals this year', el('q-goals').value.trim());
      p.updated = new Date().toISOString();
      touch(id);
      flash('Patrol staged.');
    });
  }

  function textBlock(p, heading) {
    var out = '';
    (p.blocks || []).forEach(function (b) {
      if (b.type === 'text' && b.heading === heading) out = b.body || '';
    });
    return out;
  }

  function setTextBlock(p, heading, body) {
    p.blocks = p.blocks || [];
    var found = null;
    p.blocks.forEach(function (b) { if (b.type === 'text' && b.heading === heading) found = b; });
    if (!body) {
      if (found) p.blocks = p.blocks.filter(function (b) { return b !== found; });
      return;
    }
    if (found) found.body = body;
    else p.blocks.unshift({ type: 'text', heading: heading, body: body });
  }

  /* ──────────────────────────────────────── panel: banner and site ─────── */

  function renderSite() {
    var host = el('s-form');
    if (!canSave('site')) {
      host.innerHTML = '<div class="notice notice-error">site.json could not be loaded, so it cannot be edited.</div>';
      return;
    }
    var s = files.site.data;
    var b = s.banner || {};
    var m = s.meeting || {};
    var flags = s.flags || {};

    host.innerHTML =
      '<div class="sidebar-card">' +
        '<h3>Announcement banner</h3>' +
        '<div class="field"><label style="display:inline-flex;gap:.5rem;align-items:center">' +
          '<input type="checkbox" id="s-banner-on" style="width:auto"' + (flags.showBanner ? ' checked' : '') + ' />' +
          ' Show the banner on every page</label></div>' +
        area('Banner text', 's-banner-text', b.text || '', 2,
             'Keep it to one sentence. "No meeting 25 November — Thanksgiving."') +
        row(
          fld('Link (optional)', 's-banner-href', 'text', b.href || '') +
          fld('Link label', 's-banner-label', 'text', b.linkLabel || '')
        ) +
        '<p class="field-hint">Changing the text makes the banner reappear for everyone, ' +
        'including people who dismissed the last one.</p>' +
      '</div>' +

      '<div class="sidebar-card">' +
        '<h3>Usual meeting</h3>' +
        row(
          fld('Night', 's-night', 'text', m.night || '') +
          fld('Where', 's-location', 'text', m.location || '')
        ) +
        row(
          fld('Start', 's-start', 'time', m.start || '') +
          fld('End', 's-end', 'time', m.end || '')
        ) +
        '<p class="field-hint">These fill in every meeting that does not set its own.</p>' +
      '</div>' +

      '<div class="sidebar-card">' +
        '<h3>Google Calendar</h3>' +
        fld('Calendar ID', 's-gcal-id', 'text', (s.calendar || {}).googleCalendarId || '') +
        fld('Public embed URL', 's-gcal-embed', 'text', (s.calendar || {}).embedHref || '') +
        fld('Subscribe URL', 's-gcal-sub', 'text', (s.calendar || {}).subscribeHref || '') +
        '<p class="field-hint">Filling these in shows the calendar and the subscribe buttons. ' +
        'Automatically pushing this schedule into Google Calendar is a separate job and is not ' +
        'switched on yet.</p>' +
      '</div>' +

      '<div class="pill-row"><button class="btn btn-primary btn-sm" type="button" id="s-save">Stage these changes</button></div>';

    el('s-save').addEventListener('click', function () {
      s.banner = s.banner || {};
      s.banner.text = el('s-banner-text').value.trim();
      s.banner.href = el('s-banner-href').value.trim();
      s.banner.linkLabel = el('s-banner-label').value.trim();
      s.flags = s.flags || {};
      s.flags.showBanner = el('s-banner-on').checked;

      s.meeting = s.meeting || {};
      s.meeting.night = el('s-night').value.trim();
      s.meeting.location = el('s-location').value.trim();
      s.meeting.start = el('s-start').value;
      s.meeting.end = el('s-end').value;

      s.calendar = s.calendar || {};
      s.calendar.googleCalendarId = el('s-gcal-id').value.trim();
      s.calendar.embedHref = el('s-gcal-embed').value.trim();
      s.calendar.subscribeHref = el('s-gcal-sub').value.trim();

      touch('site');
      flash('Site details staged.');
    });
  }

  /* ─────────────────────────────────────────────── staging + save ──────── */

  function touch(id) {
    var f = files[id];
    f.data.updated = new Date().toISOString();
    dirty[id] = stringify(f.data) !== f.original;
    if (!dirty[id]) delete dirty[id];
    updateSaveBar();
  }

  function updateSaveBar() {
    var ids = Object.keys(dirty);
    var bar = el('save-bar');
    if (!ids.length) {
      hide(bar);
      el('sb-status').textContent = 'No changes staged.';
      return;
    }
    show(bar);
    el('sb-status').textContent = ids.length + ' file' + (ids.length > 1 ? 's' : '') +
      ' staged: ' + ids.map(function (i) { return files[i].path.replace('data/', ''); }).join(', ');
  }

  function bindSaveBar() {
    el('sb-discard').addEventListener('click', function () {
      if (!confirm('Throw away every staged change?')) return;
      location.reload();
    });

    el('sb-diff').addEventListener('click', function () {
      var wrap = el('diff-wrap');
      if (!wrap.classList.contains('is-hidden')) { hide(wrap); return; }
      el('diff').innerHTML = Object.keys(dirty).map(function (id) {
        return '<span class="ctx">── ' + esc(files[id].path) + ' ──</span>\n' +
               diffLines(files[id].original, stringify(files[id].data));
      }).join('\n\n');
      show(wrap);
      wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    el('sb-publish').addEventListener('click', publish);

    window.addEventListener('beforeunload', function (ev) {
      if (!Object.keys(dirty).length) return;
      ev.preventDefault();
      ev.returnValue = '';
    });
  }

  /* Counts the entries in a content file, so a save that quietly drops most of
     them can be caught before it is published. */
  function countEntries(obj) {
    var n = 0;
    Object.keys(obj || {}).forEach(function (k) {
      if (Array.isArray(obj[k])) n += obj[k].length;
    });
    return n;
  }

  function wipeCheck(id) {
    var f = files[id];
    var before = countEntries(JSON.parse(f.original));
    var after = countEntries(f.data);
    if (after >= before) return null;
    var lost = before - after;
    if (lost > 5 || (before > 0 && after / before < 0.6)) {
      return lost + ' of ' + before + ' entries would be removed from ' + f.path;
    }
    return null;
  }

  function publish() {
    var ids = Object.keys(dirty);
    if (!ids.length) return;

    var blocked = ids.filter(function (id) { return !canSave(id); });
    if (blocked.length) {
      alert('These files did not load, so they cannot be published over:\n' +
            blocked.map(function (i) { return files[i].path; }).join('\n'));
      return;
    }

    var confirmShrink = false;
    var warnings = ids.map(wipeCheck).filter(Boolean);
    if (warnings.length) {
      if (!confirm('This is a big deletion:\n\n' + warnings.join('\n') +
                   '\n\nPublish anyway?')) return;
      confirmShrink = true;
    }

    var worker = (E.site.admin || {}).workerUrl || '';
    if (!worker) {
      alert('Publishing is not switched on yet: no Worker URL is set in site.json.\n\n' +
            'Your changes are still staged in this tab — copy them out with "Preview changes" ' +
            'if you need them.');
      return;
    }

    setBusy(true, 'Publishing…');

    var queue = ids.slice();
    (function next() {
      if (!queue.length) {
        setBusy(false, '');
        updateSaveBar();
        flash('Published. The live site updates within a minute or two.');
        return;
      }
      var id = queue.shift();
      var f = files[id];
      var body = {
        password: session.password,
        path: f.path,
        content: stringify(f.data),
        message: 'Content: ' + f.path.replace('data/', '') + ' (via the troop editor)',
        confirmShrink: confirmShrink
      };
      fetch(worker.replace(/\/$/, '') + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
      }).then(function (res) {
        if (!res.ok) throw new Error(res.error || 'unknown error');
        f.original = body.content;
        delete dirty[id];
        next();
      }).catch(function (err) {
        setBusy(false, '');
        alert('Could not publish ' + f.path + ':\n' + err.message +
              '\n\nNothing after this file was published. Your changes are still staged.');
        updateSaveBar();
      });
    })();
  }

  function setBusy(on, label) {
    ['sb-publish', 'sb-discard', 'sb-diff'].forEach(function (i) { el(i).disabled = on; });
    if (label) el('sb-status').textContent = label;
  }

  function flash(msg) {
    var host = el('load-status');
    var n = document.createElement('div');
    n.className = 'notice notice-ok';
    n.textContent = msg;
    host.appendChild(n);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 4000);
  }

  /* ─────────────────────────────────────────────────── little helpers ──── */

  function stringify(o) { return JSON.stringify(o, null, 2) + '\n'; }

  function setOrDrop(obj, key, value, blank) {
    if (!value || value === blank) delete obj[key];
    else obj[key] = value;
  }

  function addIf(obj, key, value) { if (value) obj[key] = value; }

  function lines(s) {
    return String(s || '').split('\n').map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length; });
  }

  function pairs(s) {
    return lines(s).map(function (l) {
      var i = l.indexOf('|');
      var label = i > -1 ? l.slice(0, i).trim() : l;
      var href = i > -1 ? l.slice(i + 1).trim() : '';
      var o = { label: label, href: href };
      if (/\.pdf$/i.test(href)) o.type = 'pdf';
      return o;
    }).filter(function (o) { return o.href; });
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  /* Form-field builders — plain strings, so a whole panel is one innerHTML. */
  function fld(label, id, type, value, hint) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" value="' + esc(String(value == null ? '' : value)) + '" />' +
      (hint ? '<p class="field-hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function area(label, id, value, rows, hint) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<textarea id="' + id + '" rows="' + (rows || 3) + '">' + esc(value || '') + '</textarea>' +
      (hint ? '<p class="field-hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function sel_(label, id, opts, value) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
      '<select id="' + id + '">' + opts.map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' +
               esc(o[1]) + '</option>';
      }).join('') + '</select></div>';
  }

  function row(inner) { return '<div class="field-row">' + inner + '</div>'; }

  /* A plain line diff, good enough to read before publishing. */
  function diffLines(a, b) {
    var A = a.split('\n'), B = b.split('\n');
    if (A.length * B.length > 4000000) {
      return '<span class="ctx">(too large to diff — ' + A.length + ' lines → ' + B.length + ')</span>';
    }
    var m = A.length, n = B.length;
    var dp = [];
    for (var i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
    for (i = m - 1; i >= 0; i--) {
      for (var j = n - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [], ctx = 0;
    i = 0; j = 0;
    while (i < m && j < n) {
      if (A[i] === B[j]) { out.push(['ctx', A[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', A[i]]); i++; }
      else { out.push(['add', B[j]]); j++; }
    }
    while (i < m) out.push(['del', A[i++]]);
    while (j < n) out.push(['add', B[j++]]);

    // Trim long stretches of unchanged lines.
    var keep = [];
    out.forEach(function (r, k) {
      if (r[0] !== 'ctx') { keep[k] = true; return; }
      for (var d = 1; d <= 2; d++) {
        if ((out[k - d] && out[k - d][0] !== 'ctx') || (out[k + d] && out[k + d][0] !== 'ctx')) keep[k] = true;
      }
    });

    var html = '', skipped = 0;
    out.forEach(function (r, k) {
      if (!keep[k]) { skipped++; return; }
      if (skipped) { html += '<span class="ctx">    … ' + skipped + ' unchanged lines …</span>\n'; skipped = 0; }
      var sign = r[0] === 'add' ? '+ ' : r[0] === 'del' ? '- ' : '  ';
      html += '<span class="' + r[0] + '">' + esc(sign + r[1]) + '</span>\n';
    });
    if (skipped) html += '<span class="ctx">    … ' + skipped + ' unchanged lines …</span>\n';
    return html;
  }

  function sha256(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }
})();
