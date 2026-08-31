/* ============================================================================
   Troop 3 Pensacola — shared site script
   No framework, no build step. Loaded by every page; each page then defines
   window.onSiteReady() and renders its own content.

   Boot sequence (mirrors phsfbla's, see §2.2 of the build spec):

     window 'load'
       -> bootSite()
            1. loadSite()        fetch data/site.json
            2. applyTheme()      write --primary / --accent / --bg
            3. initChrome()      nav highlight, hamburger, dropdown, banner,
                                 header hide-on-scroll, footer fill-in
       -> window.onSiteReady()   defined per page

   RULE (§2.2): critical UI is static HTML inside <main>. This file only ever
   toggles panels and fills in slots. If onSiteReady throws, the page still
   shows a real heading and a real message — never a blank middle.

   RULE (§9.3): defaults here are STRUCTURAL, not substantive. A failed load
   must produce a visibly empty page, never a plausible-looking wrong one.
   ========================================================================== */

(function () {
  'use strict';

  var TZ = 'America/Chicago';

  /* ── Structural defaults. Deliberately empty. ───────────────────────────── */
  var SITE_DEFAULTS = {
    schema: 1,
    unit: { name: 'Troop 3', longName: 'Scouts BSA Troop 3, Pensacola', tagline: '', founded: null, charterOrg: '', council: '', councilHref: '' },
    meeting: { night: '', start: '', end: '', location: '', address: '', mapHref: '', note: '' },
    contact: {},
    calendar: {},
    banner: null,
    stats: [],
    theme: {},
    flags: {}
  };

  var T3 = window.T3 = {
    TZ: TZ,
    site: SITE_DEFAULTS,
    patrols: [],
    /* 'pending' | 'ok' | 'failed' — there is deliberately no 'missing'. */
    loadState: { site: 'pending', patrols: 'pending' }
  };

  /* ══════════════════════════════════════════════════════════════════════════
     Small helpers
     ═══════════════════════════════════════════════════════════════════════ */

  /** Escape for safe interpolation into innerHTML. Use on EVERY value that
   *  came out of JSON. There is no templating library here to do it for us. */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Only allow hrefs we are willing to put in the DOM. Anything odd becomes
   *  '#', which is inert. */
  function safeHref(h) {
    if (!h) return '#';
    var s = String(h).trim();
    if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
    if (/^[/#?]/.test(s)) return s;
    if (/^[\w.\-]+\.html(\?|#|$)/.test(s)) return s;
    return '#';
  }

  function isExternal(h) { return /^https?:/i.test(String(h || '')); }

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function el(id) { return document.getElementById(id); }

  /* Take an element or an element id, so a caller never has to remember which.
     A missing element is a no-op: a page that does not have a given panel
     should not throw on its way to showing the rest of itself. */
  function node(x) { return typeof x === 'string' ? document.getElementById(x) : x; }
  function show(x) { var n = node(x); if (n) n.classList.remove('is-hidden'); }
  function hide(x) { var n = node(x); if (n) n.classList.add('is-hidden'); }

  /* ── Dates. Everything is computed in America/Chicago, never in the
        visitor's zone. A phone in another time zone must not see a different
        "next meeting". ─────────────────────────────────────────────────── */

  /** Today's date in the troop's time zone, as 'YYYY-MM-DD'. */
  function today() {
    try {
      var p = new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
    } catch (e) { /* fall through */ }
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** Parse 'YYYY-MM-DD' into a Date at local noon — noon avoids every
   *  daylight-saving and UTC-offset edge case that bites date-only values. */
  function parseISO(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  }

  var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MON = ['January', 'February', 'March', 'April', 'May', 'June',
             'July', 'August', 'September', 'October', 'November', 'December'];

  /** 'Tuesday 8 September' / 'Tue 8 Sep' / '8 Sep 2026' */
  function fmtDate(iso, style) {
    var d = parseISO(iso);
    if (!d) return String(iso || '');
    var day = d.getDate(), mon = MON[d.getMonth()], dow = DOW[d.getDay()], yr = d.getFullYear();
    switch (style) {
      case 'short':  return dow.slice(0, 3) + ' ' + day + ' ' + mon.slice(0, 3);
      case 'numeric': return day + ' ' + mon.slice(0, 3) + ' ' + yr;
      case 'long':   return dow + ' ' + day + ' ' + mon + ' ' + yr;
      case 'monthYear': return mon + ' ' + yr;
      default:       return dow + ' ' + day + ' ' + mon;
    }
  }

  /** '18:30' -> '6:30 PM' */
  function fmtTime(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return '';
    var h = +m[1], mi = m[2], ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + mi + ' ' + ap;
  }

  /** '6:30 – 8:30 PM', collapsing the meridiem when both halves share one. */
  function fmtTimeRange(a, b) {
    if (!a) return '';
    if (!b) return fmtTime(a);
    var A = fmtTime(a), B = fmtTime(b);
    var apA = A.slice(-2), apB = B.slice(-2);
    if (apA === apB) A = A.slice(0, -3);
    return A + '–' + B;
  }

  /** Inclusive date-range label for multi-day events. */
  function fmtDateRange(a, b) {
    if (!b || b === a) return fmtDate(a);
    var d1 = parseISO(a), d2 = parseISO(b);
    if (!d1 || !d2) return fmtDate(a);
    if (d1.getMonth() === d2.getMonth() && d1.getFullYear() === d2.getFullYear()) {
      return DOW[d1.getDay()].slice(0, 3) + ' ' + d1.getDate() + '–' + d2.getDate() + ' ' + MON[d1.getMonth()];
    }
    return fmtDate(a, 'short') + ' – ' + fmtDate(b, 'short');
  }

  /* ══════════════════════════════════════════════════════════════════════════
     Data loading
     ═══════════════════════════════════════════════════════════════════════ */

  /** Fetch a JSON file under data/. Always no-store with a cache buster, so a
   *  content edit is never waiting on a CDN. Rejects on any non-2xx — a 404 is
   *  a failure, never "empty" (§9.3). */
  function loadJSON(path) {
    var url = path + (path.indexOf('?') > -1 ? '&' : '?') + '_=' + Date.now();
    var opts = { cache: 'no-store' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      try { opts.signal = AbortSignal.timeout(8000); } catch (e) { /* older browser */ }
    }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  /** Shallow-merge a loaded site.json over the structural defaults. Only the
   *  top-level shape is filled in; values are never invented. */
  function mergeSite(loaded) {
    var out = {}, k;
    for (k in SITE_DEFAULTS) if (Object.prototype.hasOwnProperty.call(SITE_DEFAULTS, k)) out[k] = SITE_DEFAULTS[k];
    for (k in loaded) if (Object.prototype.hasOwnProperty.call(loaded, k)) {
      var d = SITE_DEFAULTS[k], v = loaded[k];
      if (d && typeof d === 'object' && !Array.isArray(d) && v && typeof v === 'object' && !Array.isArray(v)) {
        var sub = {}, j;
        for (j in d) sub[j] = d[j];
        for (j in v) sub[j] = v[j];
        out[k] = sub;
      } else {
        out[k] = v;
      }
    }
    out.calendar = calendarLinks(out.calendar);
    return out;
  }

  /* One field switches the calendar on. googleCalendarId is all anyone should
     have to paste; the embed, the Google subscribe link and the .ics feed are
     the same id in three shapes. An explicit href in site.json still wins. */
  function calendarLinks(cal) {
    var c = cal || {};
    var id = String(c.googleCalendarId || '').trim();
    if (!id) return c;
    var enc = encodeURIComponent(id);
    return {
      googleCalendarId: id,
      embedHref: c.embedHref ||
        'https://calendar.google.com/calendar/embed?src=' + enc + '&ctz=America%2FChicago',
      subscribeHref: c.subscribeHref ||
        'https://calendar.google.com/calendar/render?cid=' + enc,
      icsHref: c.icsHref ||
        'https://calendar.google.com/calendar/ical/' + enc + '/public/basic.ics',
      note: c.note
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     Theme
     ═══════════════════════════════════════════════════════════════════════ */

  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement;
    if (theme.primary) root.style.setProperty('--primary', theme.primary);
    if (theme.accent)  root.style.setProperty('--accent', theme.accent);
    if (theme.bg)      root.style.setProperty('--bg', theme.bg);
    if (theme.fontBody) root.style.setProperty('--font-body', theme.fontBody);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     Chrome: nav highlight, hamburger, dropdown, banner, footer, header scroll
     ═══════════════════════════════════════════════════════════════════════ */

  function highlightActiveNav() {
    var file = window.location.pathname.split('/').pop() || 'index.html';
    var map = {
      'meeting.html': 'meetings.html',
      'event.html': 'calendar.html',
      'patrol.html': 'patrols.html',
      'trail.html': 'resources.html',
      'trails.html': 'resources.html',
      'forms.html': 'resources.html',
      'eagle.html': 'advancement.html',
      'new-scouts.html': 'about.html'
    };
    var target = map[file] || file;
    var links = document.querySelectorAll('nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href').split('?')[0].split('#')[0];
      if (href === target) links[i].classList.add('active');
    }
  }

  function initHamburger() {
    var ham = el('hamburger'), nav = el('main-nav');
    if (!ham || !nav) return;
    ham.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      ham.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // Closing the menu should also collapse the patrols accordion inside it.
    nav.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a') && window.innerWidth <= 860) {
        nav.classList.remove('open');
        ham.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ── The Patrols dropdown (§6.2) ────────────────────────────────────────
     Desktop: hover with an open delay and a longer close delay, plus click
     and full keyboard support. Mobile: an accordion where the label navigates
     and the chevron expands. If the patrol index fails to load, the trigger
     degrades to a plain link — it never becomes a dead control. */
  function initPatrolsDropdown(patrols, ok) {
    var dd = el('nav-patrols');
    if (!dd) return;
    var trigger = dd.querySelector('.nav-trigger');
    var mobileBtn = dd.querySelector('.nav-dd-mobile button');
    var panel = el('nav-patrols-panel');
    if (!trigger || !panel) return;

    // Fill the panel.
    if (ok && patrols.length) {
      var html = patrols.map(function (p) {
        return '<a role="menuitem" href="patrol.html?p=' + encodeURIComponent(p.slug) + '">' +
               '<span class="dot" style="background:' + esc(cssColor(p.color)) + '"></span>' +
               esc(p.name || p.slug) + '</a>';
      }).join('');
      panel.innerHTML = html +
        '<div class="panel-sep" role="separator"></div>' +
        '<a role="menuitem" class="panel-all" href="patrols.html">All patrols &rarr;</a>';
    } else {
      // Degradation path: no data, so no menu. The trigger becomes a link.
      degradeTrigger();
      return;
    }

    var openT = null, closeT = null;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function open() {
      clearTimeout(closeT);
      dd.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'true');
      if (reduced) { dd.classList.add('shown'); }
      else { requestAnimationFrame(function () { dd.classList.add('shown'); }); }
    }
    function close() {
      clearTimeout(openT);
      dd.classList.remove('open', 'shown');
      trigger.setAttribute('aria-expanded', 'false');
      if (mobileBtn) mobileBtn.setAttribute('aria-expanded', 'false');
    }
    function isOpen() { return dd.classList.contains('open'); }
    function isDesktop() { return window.innerWidth > 860; }

    // Mouse: 150ms to open, ~300ms to close so the cursor can cut the corner
    // into the panel without it snapping shut.
    dd.addEventListener('mouseenter', function () {
      if (!isDesktop()) return;
      clearTimeout(closeT);
      openT = setTimeout(open, 150);
    });
    dd.addEventListener('mouseleave', function () {
      if (!isDesktop()) return;
      clearTimeout(openT);
      closeT = setTimeout(close, 300);
    });

    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      isOpen() ? close() : open();
    });

    if (mobileBtn) {
      mobileBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        isOpen() ? close() : open();
      });
    }

    function items() { return Array.prototype.slice.call(panel.querySelectorAll('a')); }

    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault(); isOpen() ? close() : open();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); open(); var it = items(); if (it[0]) it[0].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); open(); var l = items(); if (l.length) l[l.length - 1].focus();
      } else if (e.key === 'Escape') {
        close();
      }
    });

    panel.addEventListener('keydown', function (e) {
      var it = items(), i = it.indexOf(document.activeElement);
      if (e.key === 'ArrowDown')      { e.preventDefault(); it[(i + 1) % it.length].focus(); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus(); }
      else if (e.key === 'Home')      { e.preventDefault(); it[0].focus(); }
      else if (e.key === 'End')       { e.preventDefault(); it[it.length - 1].focus(); }
      else if (e.key === 'Escape')    { e.preventDefault(); close(); trigger.focus(); }
      else if (e.key === 'Tab')       { close(); }
    });

    // Any focus or click that leaves the dropdown closes it.
    document.addEventListener('focusin', function (e) {
      if (isOpen() && !dd.contains(e.target)) close();
    });
    document.addEventListener('click', function (e) {
      if (isOpen() && !dd.contains(e.target)) close();
    });

    function degradeTrigger() {
      var a = document.createElement('a');
      a.href = 'patrols.html';
      a.textContent = 'Patrols';
      a.id = 'nav-patrols-fallback';
      if (dd.parentNode) dd.parentNode.replaceChild(a, dd);
    }
  }

  /** Accept only a plain hex/rgb colour into a style attribute. */
  function cssColor(c) {
    var s = String(c || '').trim();
    return /^#[0-9a-f]{3,8}$/i.test(s) ? s : 'var(--red)';
  }

  /* ── Announcement banner. Dismissal is remembered against a hash of the
        text, so a NEW banner always shows again. ─────────────────────────── */
  function initBanner(banner, flags) {
    var host = el('site-banner');
    if (!host) return;
    if (!banner || !banner.text || (flags && flags.showBanner === false)) return;

    var key = 't3.banner.' + hash32(banner.text);
    try { if (localStorage.getItem(key) === '1') return; } catch (e) { /* private mode */ }

    var link = banner.href
      ? ' <a href="' + esc(safeHref(banner.href)) + '">' + esc(banner.linkLabel || 'Read more') + '</a>'
      : '';
    host.innerHTML =
      '<div class="banner" role="status">' +
        '<span>' + esc(banner.text) + '</span>' + link +
        '<button class="banner-dismiss" type="button" aria-label="Dismiss announcement">&times;</button>' +
      '</div>';
    host.querySelector('.banner-dismiss').addEventListener('click', function () {
      host.innerHTML = '';
      try { localStorage.setItem(key, '1'); } catch (e) { /* ignore */ }
    });
  }

  function hash32(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* ── Fill the small slots the pages share. ─────────────────────────────── */
  function fillChrome(site) {
    var m = site.meeting || {}, u = site.unit || {};
    setText('slot-meeting-when', m.night && m.start
      ? 'Every ' + m.night + ', ' + fmtTimeRange(m.start, m.end)
      : '');
    setText('slot-meeting-where', m.location || '');
    setText('slot-year', String(new Date().getFullYear()));
    setText('slot-charter', u.charterOrg || '');
    var mail = document.querySelectorAll('[data-slot="email"]');
    var addr = (site.contact && site.contact.email) || '';
    for (var i = 0; i < mail.length; i++) {
      if (!addr) continue;
      mail[i].textContent = addr;
      if (mail[i].tagName === 'A') mail[i].setAttribute('href', 'mailto:' + addr);
    }
  }

  function setText(id, v) {
    var n = el(id);
    if (n && v) n.textContent = v;
  }

  /* ── Header hides on scroll down, returns on scroll up. Pinned open near
        the top, while the mobile menu is open, and while focus is inside it.
        Disabled entirely under prefers-reduced-motion. ─────────────────── */
  function initHeaderScroll() {
    var header = document.querySelector('header');
    if (!header) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var HIDE_AFTER = 12, REVEAL_AFTER = 6, TOP_ZONE = 120;
    var last = window.scrollY || 0, acc = 0, ticking = false;

    function update() {
      ticking = false;
      var y = window.scrollY || 0, d = y - last;
      last = y;

      var nav = el('main-nav');
      var menuOpen = nav && nav.classList.contains('open');
      var focusInside = header.contains(document.activeElement);

      if (y < TOP_ZONE || menuOpen || focusInside) {
        header.classList.remove('header-hidden');
        acc = 0;
        return;
      }
      if (d > 0) { acc = acc > 0 ? acc + d : d; if (acc > HIDE_AFTER) header.classList.add('header-hidden'); }
      else if (d < 0) { acc = acc < 0 ? acc + d : d; if (acc < -REVEAL_AFTER) header.classList.remove('header-hidden'); }
    }

    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     Shared renderers used by more than one page
     ═══════════════════════════════════════════════════════════════════════ */

  var UNIFORM = { field: 'Class A — field uniform', activity: 'Class B — activity uniform', none: 'No uniform' };
  var KIND = {
    campout: 'Campout', 'summer-camp': 'Summer camp', 'court-of-honor': 'Court of Honor',
    oa: 'Order of the Arrow', service: 'Service', other: 'Event'
  };

  /** Effective start/end/location for a meeting, falling back to site.json. */
  function withDefaults(mtg, site) {
    var d = (site && site.meeting) || {};
    return {
      start: mtg.start || d.start || '',
      end: mtg.end || d.end || '',
      location: mtg.location || d.location || ''
    };
  }

  function statusBadge(status) {
    if (status === 'cancelled') return '<span class="badge badge-cancelled">Cancelled</span>';
    if (status === 'moved')     return '<span class="badge badge-moved">Time / place changed</span>';
    return '';
  }

  /* linked: chips are their own links to the patrol page. Use this only where the
     chips are NOT already inside a link — an <a> nested in an <a> is invalid, and
     the browser closes the outer one early, which tears the surrounding card apart. */
  function chipList(slugs, patrols, linked) {
    if (!slugs || !slugs.length) return '';
    var byslug = {};
    (patrols || []).forEach(function (p) { byslug[p.slug] = p; });
    return slugs.map(function (s) {
      var p = byslug[s] || { slug: s, name: s, color: '' };
      var open = linked
        ? '<a class="chip" href="patrol.html?p=' + encodeURIComponent(s) + '">'
        : '<span class="chip">';
      return open +
             '<span class="dot" style="background:' + esc(cssColor(p.color)) + '"></span>' +
             esc(p.name || s) + (linked ? '</a>' : '</span>');
    }).join('');
  }

  function patrolChips(slugs, patrols) { return chipList(slugs, patrols, true); }
  function patrolTags(slugs, patrols) { return chipList(slugs, patrols, false); }

  function materialsList(mats) {
    if (!mats || !mats.length) return '';
    return '<ul class="matlist">' + mats.map(function (m) {
      var href = safeHref(m.href);
      var ext = isExternal(href);
      var type = (m.type || (/\.pdf$/i.test(href) ? 'pdf' : 'link'));
      return '<li><a href="' + esc(href) + '"' +
        (ext ? ' target="_blank" rel="noopener"' : '') + '>' +
        '<span class="ftype">' + esc(String(type).toUpperCase()) + '</span>' +
        '<span>' + esc(m.label || href) + '</span>' +
        (ext ? '<span class="ext" aria-hidden="true">&#8599;</span><span class="sr-only">(opens in a new tab)</span>' : '') +
        '</a></li>';
    }).join('') + '</ul>';
  }

  /** Merge meetings and events into one date-sorted stream. */
  function mergedStream(meetings, events) {
    var out = [];
    (meetings || []).forEach(function (m) { out.push({ kind: 'meeting', date: m.date, data: m }); });
    (events || []).forEach(function (e) { out.push({ kind: 'event', date: e.date, data: e }); });
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
  }

  /** The next meeting: earliest scheduled or moved one dated today or later. */
  function nextMeeting(meetings) {
    var t = today(), best = null;
    (meetings || []).forEach(function (m) {
      if (!m.date || m.date < t) return;
      var st = m.status || 'scheduled';
      if (st === 'cancelled' || st === 'happened') return;
      if (!best || m.date < best.date) best = m;
    });
    return best;
  }

  /** The most recent past meeting that has a catch-up worth reading. */
  function lastCatchUp(meetings) {
    var t = today(), best = null;
    (meetings || []).forEach(function (m) {
      if (!m.date || m.date >= t) return;
      if (!m.catchUp || !String(m.catchUp).trim()) return;
      if (!best || m.date > best.date) best = m;
    });
    return best;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     Boot
     ═══════════════════════════════════════════════════════════════════════ */

  function bootSite() {
    var jobs = [
      loadJSON('data/site.json').then(function (d) {
        T3.site = mergeSite(d || {});
        T3.loadState.site = 'ok';
      }).catch(function (err) {
        T3.loadState.site = 'failed';
        if (window.console) console.error('[T3] site.json failed to load:', err);
      }),
      loadJSON('data/patrols/index.json').then(function (d) {
        T3.patrols = (d && d.patrols) || [];
        T3.loadState.patrols = 'ok';
      }).catch(function (err) {
        T3.loadState.patrols = 'failed';
        T3.patrols = [];
        if (window.console) console.warn('[T3] patrol index failed to load:', err);
      })
    ];

    Promise.all(jobs).then(function () {
      try {
        applyTheme(T3.site.theme);
        highlightActiveNav();
        initHamburger();
        initPatrolsDropdown(T3.patrols, T3.loadState.patrols === 'ok');
        initBanner(T3.site.banner, T3.site.flags);
        fillChrome(T3.site);
        initHeaderScroll();
      } catch (e) {
        if (window.console) console.error('[T3] chrome init failed:', e);
      }
      // The page renders itself. Anything it throws is contained here so the
      // header, footer and static shell survive.
      if (typeof window.onSiteReady === 'function') {
        try { window.onSiteReady(); }
        catch (e) {
          if (window.console) console.error('[T3] onSiteReady failed:', e);
          var f = el('page-error');
          if (f) { show(f); }
        }
      }
    });
  }

  /* ── Public surface for the page scripts ───────────────────────────────── */
  T3.esc = esc;
  T3.safeHref = safeHref;
  T3.isExternal = isExternal;
  T3.cssColor = cssColor;
  T3.qs = qs;
  T3.el = el;
  T3.show = show;
  T3.hide = hide;
  T3.loadJSON = loadJSON;
  T3.today = today;
  T3.parseISO = parseISO;
  T3.fmtDate = fmtDate;
  T3.fmtTime = fmtTime;
  T3.fmtTimeRange = fmtTimeRange;
  T3.fmtDateRange = fmtDateRange;
  T3.withDefaults = withDefaults;
  T3.statusBadge = statusBadge;
  T3.patrolChips = patrolChips;
  T3.patrolTags = patrolTags;
  T3.materialsList = materialsList;
  T3.mergedStream = mergedStream;
  T3.nextMeeting = nextMeeting;
  T3.lastCatchUp = lastCatchUp;
  T3.UNIFORM = UNIFORM;
  T3.KIND = KIND;
  T3.MONTHS = MON;
  T3.DAYS = DOW;
  T3.setPageTitle = function (title, description) {
    if (title) document.title = title;
    if (description) {
      var m = document.querySelector('meta[name="description"]');
      if (m) m.setAttribute('content', description);
    }
  };

  if (document.readyState === 'complete') bootSite();
  else window.addEventListener('load', bootSite);
})();
