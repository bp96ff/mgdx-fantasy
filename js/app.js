// Router + views. Routes: #/home, #/<league>/<standings|rosters|matchups>?team=&week=
(function () {
  const { LEAGUES, LIVE_REFRESH_MS, SEASON, ARCHIVE } = window.MGDX;
  // A past season's page (for example 2023.html) reads that season's saved files.
  const DATA = ARCHIVE ? ARCHIVE.dir : 'data/';
  const { loadAllLeagues, resolveWeek, overallRecords, crossSchedules, applyOverall } = window.SEASON_DATA;
  const { thisWeekGames, thisWeekAwards, stillPlaying } = window.THIS_WEEK;
  const main = document.getElementById('main');
  // Sign-in, posts, reactions and custom logos (js/account.js). Only the current season's page loads it.
  const ACCOUNT = window.MGDX_ACCOUNT;
  const PLACEHOLDERS = {
    blog: { title: 'Blog', kicker: 'Takes, recaps and trash talk', art: 'assets/img/mgdx-shield.png?v=3' },
    archives: { title: 'Archives', kicker: 'Seasons past', art: 'assets/img/mgdx-shield.png?v=3' },
  };
  const SUBTABS = ARCHIVE ? ['final-standings', 'standings', 'rosters', 'matchups', 'draft-board'] : ['standings', 'rosters', 'matchups', 'power-rankings', 'transactions', 'draft-board'];
  const subtabLabel = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  let refreshTimer = null;
  let renderToken = 0;
  let scheduleOpen = false; // Rosters season schedule stays open when switching team or week
  let weekCardsOpen = false; // so do the Rosters matchup cards
  let standingsExpanded = false; // phone standings: all columns stay open across leagues and re-sorts

  // Phone standings: one listener here, because the table is redrawn on league change and re-sort.
  main.addEventListener('click', (e) => {
    const btn = e.target.closest('.st-expand');
    if (!btn) return;
    standingsExpanded = !standingsExpanded;
    btn.closest('.st-panel').classList.toggle('st-expanded', standingsExpanded);
    btn.setAttribute('aria-expanded', standingsExpanded);
    btn.textContent = standingsExpanded ? 'Show fewer columns' : 'Show all columns';
  });

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f2 = (n) => (Number(n) || 0).toFixed(2);
  const f1 = (n) => (Number(n) || 0).toFixed(1);
  const record = (t) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`;
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

  const ET = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '') || 'home';
    const [path, query] = raw.split('?');
    const parts = path.split('/').filter(Boolean);
    return { parts, params: new URLSearchParams(query || '') };
  }

  // A manager's uploaded logo (js/account.js) replaces ESPN's for this season's teams. It needs the team's id;
  // callers drawing a past season's team leave the id out so a reused id doesn't pick up today's logo.
  const customLogo = (team, league) => {
    const acct = window.MGDX_ACCOUNT;
    return !ARCHIVE && acct && acct.logos && team && team.id != null && league ? acct.logos.get(`${league.slug}:${team.id}`) : null;
  };

  function teamLogo(team, league, cls = 'avatar') {
    const fallback = league.logo;
    const src = customLogo(team, league) || (team && team.logo ? team.logo : fallback);
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(fallback)}'">`;
  }

  // Small logos by a former champion's name: a golden goat per grand championship, a golden plunger per
  // ultimate loss, then a league logo per title.
  function champBadges(team) {
    const goats = Array.from({ length: team.grandTitles || 0 }, () =>
      '<img class="champ goat" src="assets/img/champs/grand-champion.png" alt="Grand champion" title="Grand champion" width="17" height="17">');
    const plungers = Array.from({ length: team.ultimateLosses || 0 }, () =>
      '<img class="champ goat" src="assets/img/champs/ultimate-loser.png" alt="Ultimate loser" title="Ultimate loser" width="17" height="17">');
    const logos = (team.titles || []).map((slug) => {
      const l = LEAGUES.find((x) => x.slug === slug);
      if (!l) return '';
      const label = `${esc(l.name)} champion`;
      return `<img class="champ" src="${l.badge}" alt="${label}" title="${label}" width="17" height="17">`;
    });
    const all = goats.concat(plungers, logos).join('');
    return all ? `<i class="champs">${all}</i>` : '';
  }

  // ---------- week dropdown (shared by Rosters and Matchups) ----------
  function maxWeek(league) {
    return Math.max(...Object.keys(league.matchupPeriods).map(Number), league.regularSeasonWeeks);
  }

  function clampWeek(league, raw) {
    const w = Number(raw) || league.currentWeek;
    return Math.min(Math.max(1, w), maxWeek(league));
  }

  function weekOptions(league, selected) {
    const options = [];
    for (let w = 1; w <= maxWeek(league); w++) {
      const tag = w === league.currentWeek ? ' · current' : w > league.regularSeasonWeeks ? ' · playoffs' : '';
      options.push(`<option value="${w}" ${w === selected ? 'selected' : ''}>Week ${w}${tag}</option>`);
    }
    return options.join('');
  }

  function loading(label = 'Loading from ESPN') {
    return `<div class="state"><span class="spinner" aria-hidden="true"></span>${esc(label)}…</div>`;
  }

  function errorBox(err, retryHash) {
    return `<div class="state state-error" role="alert">
      <strong>Couldn't reach ESPN.</strong>
      <span>${esc(err && err.message ? err.message : 'Unknown error')}</span>
      <a class="btn" href="${esc(retryHash)}" onclick="window.dispatchEvent(new HashChangeEvent('hashchange'));return false;">Try again</a>
    </div>`;
  }

  function setActiveNav(route) {
    document.querySelectorAll('#main-nav a').forEach((a) => {
      const on = a.dataset.route === route;
      a.classList.toggle('active', on);
      if (on) {
        a.setAttribute('aria-current', 'page');
        a.scrollIntoView({ block: 'nearest', inline: 'center' });
      } else a.removeAttribute('aria-current');
    });
  }

  // ---------- placeholder pages ----------
  function renderPlaceholder(key) {
    const p = PLACEHOLDERS[key];
    document.body.dataset.theme = 'home';
    document.title = `${p.title} · Microgen Fantasy Football`;
    main.innerHTML = `
      <section class="placeholder">
        <img class="placeholder-art" src="${p.art}" alt="" width="220" height="220">
        <p class="eyebrow">${esc(p.kicker)}</p>
        <h1 class="page-title">${esc(p.title)}</h1>
        <p class="placeholder-badge">In progress</p>
      </section>`;
  }

  // ---------- blog ----------
  const BLOG_TABS = ['main', 'recaps', 'predictions'];
  const BLOG_TAB_NAMES = { main: 'Main Blog', recaps: 'Recaps', predictions: 'Predictions' };
  const BLOG_KICKERS = { main: 'Takes and trash talk', recaps: 'How each week went down', predictions: 'Pick every winner' };

  function renderBlog(sub, params) {
    const p = PLACEHOLDERS.blog;
    document.body.dataset.theme = 'home';
    document.title = `${BLOG_TAB_NAMES[sub]} · Blog · Microgen Fantasy Football`;
    main.innerHTML = `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-seal.png?v=2" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow">${esc(p.kicker)}</p>
          <h1 class="page-title">${esc(p.title)}</h1>
        </div>
      </section>
      <nav class="subtabs" aria-label="Blog sections">
        ${BLOG_TABS.map((s) => `<a href="#/blog/${s}" class="${s === sub ? 'active' : ''}" ${s === sub ? 'aria-current="page"' : ''}>${BLOG_TAB_NAMES[s]}${s === 'main' && ACCOUNT && !ARCHIVE ? '<span class="nav-badge" data-unread hidden></span>' : ''}</a>`).join('')}
      </nav>
      ${sub === 'recaps' ? `<div id="league-body">${loading('Loading recaps')}</div>`
        : sub === 'main' && ACCOUNT && ACCOUNT.enabled && !ARCHIVE ? `<div id="league-body">${loading('Loading posts')}</div>`
        : sub === 'predictions' && PICKS.on ? `<div id="league-body">${loading('Loading the leaderboard')}</div>` : `
      <section class="placeholder">
        <img class="placeholder-art" src="${p.art}" alt="" width="220" height="220">
        <p class="eyebrow">${esc(BLOG_KICKERS[sub])}</p>
        <h2 class="page-title">${esc(BLOG_TAB_NAMES[sub])}</h2>
        <p class="placeholder-badge">In progress</p>
      </section>`}`;
    if (sub === 'recaps') renderRecaps(params);
    else if (sub === 'main' && ACCOUNT && ACCOUNT.enabled && !ARCHIVE) renderFeed();
    else if (sub === 'predictions' && PICKS.on) renderPredictions(params);
    if (ACCOUNT && !ARCHIVE && typeof drawUnread === 'function') drawUnread();
  }

  // ---------- reactions ----------
  // Members react to posts, recap sections and Weekly Snapshot cards. A bar shows each reaction used so
  // far with its count (hover for who); members toggle one by tapping it, or add another from the + menu.
  // Keys must match toggle_reaction() in supabase/schema.sql.
  const REACTIONS = [
    ['like', '👍', 'Like'], ['dislike', '👎', 'Dislike'], ['love', '❤️', 'Love'], ['laugh', '😂', 'Funny'], ['fire', '🔥', 'Fire'],
    ['goat', '🐐', 'GOAT'], ['king', '👑', 'King'], ['hundred', '💯', '100'], ['cool', '😎', 'Cool'], ['eyes', '👀', 'Eyes'],
    ['shocked', '😱', 'Shocked'], ['skull', '💀', 'Dead'], ['clown', '🤡', 'Clown'], ['salt', '🧂', 'Salty'], ['fuming', '😤', 'Fuming'],
    ['cry', '😭', 'Crying'], ['pray', '🙏', 'Pray'], ['lucky', '🍀', 'Lucky'], ['trash', '🗑️', 'Trash'],
  ];
  const reactCache = new Map(); // target -> [{ emoji, manager_id, name }]
  const canReact = () => Boolean(ACCOUNT && !ARCHIVE && ACCOUNT.state.me && ACCOUNT.state.me.league);
  const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function reactInner(target) {
    const rows = reactCache.get(target);
    if (!rows) return '';
    const me = canReact() ? ACCOUNT.state.me.manager_id : null;
    const chips = REACTIONS.map(([key, icon, word]) => {
      const who = rows.filter((r) => r.emoji === key);
      if (!who.length) return '';
      const mine = who.some((r) => r.manager_id === me);
      const names = who.map((r) => r.name).join(', ');
      const tip = `${word}: ${names}`;
      return me
        ? `<button type="button" class="react-chip${mine ? ' mine' : ''}" data-react-emoji="${key}" aria-pressed="${mine}" title="${esc(tip)}" aria-label="${esc(`${word}, ${who.length}. ${names}`)}"><span aria-hidden="true">${icon}</span><b>${who.length}</b></button>`
        : `<span class="react-chip" title="${esc(tip)}" aria-label="${esc(`${word}, ${who.length}. ${names}`)}"><span aria-hidden="true">${icon}</span><b>${who.length}</b></span>`;
    }).join('');
    const add = me ? `
      <details class="react-add">
        <summary title="Add a reaction" aria-label="Add a reaction"><span aria-hidden="true">☺+</span></summary>
        <div class="react-menu">${REACTIONS.map(([key, icon, word]) => `<button type="button" data-react-emoji="${key}" title="${word}" aria-label="${word}">${icon}</button>`).join('')}</div>
      </details>` : '';
    return chips + add;
  }
  const reactBar = (target) => `<div class="react" data-react="${esc(target)}">${reactInner(target)}</div>`;
  const redrawReactions = (target) => {
    // A redraw can change a post's height; keep the Main Blog's scroll box the same distance from the bottom.
    const box = document.querySelector('.post-scroll');
    const fromBottom = box && box.scrollHeight - box.scrollTop;
    document.querySelectorAll('.react[data-react]').forEach((el) => {
      if (!target || el.dataset.react === target) el.innerHTML = reactInner(el.dataset.react);
    });
    if (box) box.scrollTop = box.scrollHeight - fromBottom;
  };

  // Loads reactions for every bar under root that hasn't loaded yet, in one request.
  async function hydrateReactions(root) {
    const want = [...root.querySelectorAll('.react[data-react]')].map((el) => el.dataset.react).filter((t) => !reactCache.has(t));
    if (!want.length || !ACCOUNT) return;
    try {
      const rows = await ACCOUNT.read('get_reactions', { p_targets: [...new Set(want)] });
      for (const t of want) reactCache.set(t, []);
      for (const r of rows) reactCache.get(r.target).push(r);
    } catch (err) {
      console.warn('Reactions unavailable', err);
      return;
    }
    for (const t of new Set(want)) redrawReactions(t);
  }

  // Adds a reaction bar to each item (once; a redraw keeps it from the cache), then loads what's missing.
  // On a past season's page there's nothing to react to.
  function attachReactions(root, items) {
    if (!ACCOUNT || !ACCOUNT.enabled || ARCHIVE) return;
    for (const { el, target, before } of items) {
      if (!el || el.querySelector(':scope > .react')) continue;
      const spot = before && el.querySelector(`:scope > ${before}`);
      if (spot) spot.insertAdjacentHTML('beforebegin', reactBar(target));
      else el.insertAdjacentHTML('beforeend', reactBar(target));
    }
    hydrateReactions(root);
  }

  if (ACCOUNT && !ARCHIVE) {
    document.addEventListener('click', async (e) => {
      // Close an open + menu when tapping anywhere else
      document.querySelectorAll('.react-add[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
      // The menu floats over the page (so no card or scroll box cuts it off): above its button where there's
      // room below the sticky header, otherwise below, and kept inside the screen's width.
      const sum = e.target.closest('.react-add summary');
      if (sum) {
        const m0 = sum.parentElement.querySelector('.react-menu');
        if (m0) m0.classList.remove('placed'); // hidden until it's in place, so it doesn't flash in the corner
        requestAnimationFrame(() => {
          const d = sum.parentElement;
          const menu = d.querySelector('.react-menu');
          if (!d.open || !menu) return;
          const r = sum.getBoundingClientRect();
          const header = document.querySelector('.site-header');
          const minTop = (header ? header.getBoundingClientRect().bottom : 0) + 6;
          const h = menu.offsetHeight, w = menu.offsetWidth;
          menu.style.top = `${r.top - h - 6 >= minTop ? r.top - h - 6 : r.bottom + 6}px`;
          menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
          menu.classList.add('placed');
        });
      }
      const b = e.target.closest('.react [data-react-emoji]');
      if (!b || !canReact()) return;
      const bar = b.closest('.react');
      const target = bar.dataset.react;
      const emoji = b.dataset.reactEmoji;
      const me = ACCOUNT.state.me;
      const rows = reactCache.get(target) || [];
      const had = rows.some((r) => r.emoji === emoji && r.manager_id === me.manager_id);
      // Show it right away; undo if the database says no.
      const next = had ? rows.filter((r) => !(r.emoji === emoji && r.manager_id === me.manager_id))
        : rows.concat({ emoji, manager_id: me.manager_id, name: me.name });
      reactCache.set(target, next);
      redrawReactions(target);
      try {
        await ACCOUNT.write('toggle_reaction', { p_target: target, p_emoji: emoji });
      } catch (err) {
        reactCache.set(target, rows);
        redrawReactions(target);
        alert(err.message);
      }
    });
    // Signing in or out changes who can react; redraw every bar.
    ACCOUNT.onChange(() => redrawReactions());
    // A floating menu would drift from its button on scroll, so scrolling closes it.
    document.addEventListener('scroll', (e) => {
      if (e.target.closest && e.target.closest('.react-menu')) return;
      document.querySelectorAll('.react-add[open]').forEach((d) => { d.open = false; });
    }, { capture: true, passive: true });
  }

  // ---------- Predictions: picks on game cards ----------
  // Members pick the winner of every in-league and cross-league game, on the Matchups and Cross-League tabs.
  // A week's picks lock when its first NFL game kicks off (pick_locks in supabase/schema.sql); until then only
  // the member sees their own picks, and after it everyone's are public. A correct favorite is worth 1 point,
  // a correct underdog 2. The favorite has the higher max projected lineup (the best lineup its roster could
  // start, by ESPN projections), saved at kickoff to data/predictions.json by tools/run-pick-favorites.js;
  // before kickoff the cards show the live numbers.
  const PICKS = (() => {
    const on = Boolean(ACCOUNT && ACCOUNT.enabled && !ARCHIVE);
    // Resolved data, so a card can redraw at once: locks (week -> ms), fav (data/predictions.json),
    // tallies ('week|game' -> Map(team -> manager ids)), mine (week -> Map(game -> team)).
    const state = { locks: null, fav: null, tallies: new Map(), mine: new Map() };
    let locksP = null, favP = null, favT = 0, talliesP = null, talliesT = 0;
    const mineP = new Map();
    function locks() {
      if (!locksP) {
        locksP = ACCOUNT.read('pick_weeks').then((rows) => (state.locks = new Map(rows.map((r) => [r.week, Date.parse(r.locks_at)]))));
        locksP.catch((err) => { console.warn('Pick locks unavailable', err); locksP = null; });
      }
      return locksP.catch(() => new Map());
    }
    function favorites() {
      if (!favP || Date.now() - favT > 300000) {
        favT = Date.now();
        favP = fetch(`${DATA}predictions.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          .then((f) => (state.fav = f));
      }
      return favP;
    }
    function tallies() {
      if (!talliesP || Date.now() - talliesT > 60000) {
        talliesT = Date.now();
        talliesP = ACCOUNT.read('pick_tallies').then((rows) => {
          const map = new Map();
          for (const r of rows) {
            const k = `${r.week}|${r.game}`;
            if (!map.has(k)) map.set(k, new Map());
            map.get(k).set(r.pick, r.managers);
          }
          state.tallies = map;
          return rows;
        });
        talliesP.catch((err) => { console.warn('Picks unavailable', err); talliesP = null; });
      }
      return talliesP.catch(() => []);
    }
    function mine(week) {
      if (!canReact()) return Promise.resolve(null);
      if (!mineP.has(week)) {
        const p = ACCOUNT.write('my_picks', { p_week: week }).then((rows) => {
          state.mine.set(week, new Map(rows.map((r) => [r.game, r.pick])));
        });
        p.catch((err) => { console.warn('Your picks are unavailable', err); mineP.delete(week); });
        mineP.set(week, p);
      }
      return mineP.get(week).catch(() => null);
    }
    // A different member (or none): forget the last one's picks.
    let who = null;
    function resetMine() {
      const now = canReact() ? ACCOUNT.state.me.manager_id : null;
      if (now === who) return false;
      who = now;
      state.mine.clear();
      mineP.clear();
      return true;
    }
    return { on, state, locks, favorites, tallies, mine, resetMine };
  })();

  // A game's name in the database: its two teams, lower first ('lab-rats:1-12', 'x:genomic-gerbils.8-lab-rats.1').
  const pickRef = (league, team) => `${league.slug}.${team.id}`;
  function pickGame(a, b, cross) {
    if (cross) return `x:${[a, b].sort().join('-')}`;
    const [slug, x] = a.split('.');
    const [lo, hi] = [Number(x), Number(b.split('.')[1])].sort((m, n) => m - n);
    return `${slug}:${lo}-${hi}`;
  }
  const managerName = (id) => id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  function lockText(ms) {
    const d = new Date(ms);
    const soon = ms - Date.now() < 6 * 86400e3;
    return d.toLocaleString('en-US', soon ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  // Points for a correct pick: 1 for the favorite (or an even game, or one with no projections), 2 for the underdog.
  // A Matchup of the Week (double) is worth twice that.
  function pickWorth(proj, pick, other, double) {
    const base = !proj || proj[pick] == null || proj[other] == null || proj[pick] >= proj[other] ? 1 : 2;
    return double ? base * 2 : base;
  }
  const pts = (n) => `${n} pt${n === 1 ? '' : 's'}`;

  // One side of a card for the pick bar. proj is the live max projected lineup, when ESPN has the roster.
  const pickSide = (side, league) => ({
    ref: pickRef(league, side.team),
    owner: side.team.owner || side.team.name,
    proj: side.lineup ? Math.round(THIS_WEEK.potentialPoints(side.lineup, league.slotCounts, (p) => p.proj) * 100) / 100 : null,
  });
  const pickResult = (g, a, b) => (!g.decided ? null : g.winner === 'home' ? a.ref : g.winner === 'away' ? b.ref : 'tie');

  const pickCards = new Map(); // 'week|game' -> { week, game, a, b, winner }
  // Adds a pick bar to each card (above its reactions), then fills them in once the picks load.
  function attachPicks(root, week, items) {
    if (!PICKS.on) return;
    for (const it of items) {
      if (!it.el) continue;
      const game = pickGame(it.a.ref, it.b.ref, it.cross);
      const key = `${week}|${game}`;
      pickCards.set(key, { ...it, el: null, week, game });
      if (it.el.querySelector(':scope > .gp')) continue;
      const html = `<div class="gp" data-pick="${esc(key)}" hidden></div>`;
      const spot = it.el.querySelector(':scope > .react, :scope > .toggle');
      if (spot) spot.insertAdjacentHTML('beforebegin', html);
      else it.el.insertAdjacentHTML('beforeend', html);
    }
    loadPicks(week).then(() => drawPicks(root, week));
  }
  async function loadPicks(week) {
    PICKS.resetMine();
    const [locks] = await Promise.all([PICKS.locks(), PICKS.favorites(), PICKS.mine(week)]);
    if (locks.has(week) && Date.now() >= locks.get(week)) await PICKS.tallies();
  }
  function drawPicks(root, week) {
    root.querySelectorAll('.gp[data-pick]').forEach((el) => {
      if (week == null || el.dataset.pick.startsWith(`${week}|`)) drawPick(el);
    });
  }

  function drawPick(el) {
    const it = pickCards.get(el.dataset.pick);
    const S = PICKS.state;
    const lock = it && S.locks && S.locks.get(it.week);
    if (lock == null) { el.hidden = true; return; } // no picks this week (playoffs), or they didn't load
    const locked = Date.now() >= lock;
    const saved = locked && S.fav && S.fav.season === SEASON && S.fav.weeks && S.fav.weeks[it.week];
    const proj = saved ? saved.proj : { [it.a.ref]: it.a.proj, [it.b.ref]: it.b.proj };
    const known = proj[it.a.ref] != null && proj[it.b.ref] != null;
    const worthOf = (s, o) => pickWorth(proj, s.ref, o.ref, it.double);
    const tag = (s, o) => (!known ? (it.double ? `Double · ${pts(worthOf(s, o))}` : '') : proj[s.ref] === proj[o.ref] ? `Even · ${pts(worthOf(s, o))}`
      : pickWorth(proj, s.ref, o.ref) === 2 ? `Underdog · ${pts(worthOf(s, o))}` : `Favorite · ${pts(worthOf(s, o))}`);
    const twice = it.double ? '<span class="gp-double" title="Matchup of the Week: correct picks score double">2x points</span>' : '';
    const projLine = known ? `Max projected ${f1(proj[it.a.ref])}–${f1(proj[it.b.ref])}` : '';
    const mine = S.mine.get(it.week);
    const myPick = mine && mine.get(it.game);
    if (!locked) {
      if (!canReact()) { el.hidden = true; return; }
      el.hidden = false;
      el.className = 'gp';
      el.innerHTML = `
        <div class="gp-head"><b>Your pick${twice}</b><small>${known ? `${projLine} for now · ` : ''}Locks ${esc(lockText(lock))}</small></div>
        <div class="gp-opts">${[[it.a, it.b], [it.b, it.a]].map(([s, o]) => `
          <button type="button" class="gp-opt${myPick === s.ref ? ' on' : ''}" data-pick-team="${esc(s.ref)}" aria-pressed="${myPick === s.ref}">
            <span class="gp-dot" aria-hidden="true"></span><b>${esc(s.owner)}</b>${tag(s, o) ? `<small>${tag(s, o)}</small>` : ''}
          </button>`).join('')}</div>`;
      return;
    }
    // Locked: how everyone picked, and how the member's pick did.
    const t = S.tallies.get(`${it.week}|${it.game}`) || new Map();
    const who = (s) => t.get(s.ref) || [];
    const na = who(it.a).length, nb = who(it.b).length;
    if (!na && !nb && !myPick) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'gp locked';
    const pct = na + nb ? Math.round((100 * na) / (na + nb)) : 50;
    const list = (s) => (who(s).length ? `Picked ${s.owner}: ${who(s).map(managerName).join(', ')}` : `No one picked ${s.owner}`);
    let mineLine = '';
    if (myPick) {
      const s = myPick === it.a.ref ? it.a : it.b;
      const o = s === it.a ? it.b : it.a;
      const worth = worthOf(s, o);
      const [cls, result] = !it.winner ? ['', `${pts(worth)} if ${esc(s.owner)} wins`]
        : it.winner === s.ref ? ['right', `Correct · +${worth}`] : it.winner === 'tie' ? ['', 'Tie · no points'] : ['wrong', 'Missed · 0'];
      mineLine = `<p class="gp-mine ${cls}">Your pick: <b>${esc(s.owner)}</b> · ${result}</p>`;
    }
    el.innerHTML = `
      <div class="gp-head"><b>Picks${twice}</b><small>${known ? `${projLine}${saved ? (saved.late ? ' (saved after kickoff)' : ' at kickoff') : ' (estimate)'}` : 'Locked'}</small></div>
      <div class="gp-split">
        <span title="${esc(list(it.a))}"><b>${na}</b> ${esc(it.a.owner)}${tag(it.a, it.b) ? ` <small>${tag(it.a, it.b).split(' · ')[0]}</small>` : ''}</span>
        <div class="bar" role="img" aria-label="${esc(`${na} picked ${it.a.owner}, ${nb} picked ${it.b.owner}`)}"><i style="width:${pct}%"></i></div>
        <span title="${esc(list(it.b))}">${tag(it.b, it.a) ? `<small>${tag(it.b, it.a).split(' · ')[0]}</small> ` : ''}${esc(it.b.owner)} <b>${nb}</b></span>
      </div>${mineLine}`;
  }

  if (PICKS.on) {
    document.addEventListener('click', async (e) => {
      const b = e.target.closest('.gp-opt');
      if (!b || !canReact()) return;
      const el = b.closest('.gp');
      const it = pickCards.get(el.dataset.pick);
      const lock = PICKS.state.locks && PICKS.state.locks.get(it.week);
      if (lock == null || Date.now() >= lock) {
        drawPick(el);
        alert(`Week ${it.week} picks are locked.`);
        return;
      }
      const S = PICKS.state;
      if (!S.mine.has(it.week)) S.mine.set(it.week, new Map());
      const mine = S.mine.get(it.week);
      const before = mine.get(it.game);
      const next = before === b.dataset.pickTeam ? null : b.dataset.pickTeam; // tapping your pick again clears it
      if (next) mine.set(it.game, next); else mine.delete(it.game);
      drawPick(el);
      try {
        await ACCOUNT.write('set_pick', { p_week: it.week, p_game: it.game, p_pick: next });
      } catch (err) {
        if (before) mine.set(it.game, before); else mine.delete(it.game);
        drawPick(el);
        alert(err.message);
      }
    });
    // Signing in or out changes whose picks show.
    ACCOUNT.onChange(() => {
      if (!PICKS.resetMine()) return;
      const weeks = new Set([...document.querySelectorAll('.gp[data-pick]')].map((el) => Number(el.dataset.pick.split('|')[0])));
      for (const w of weeks) loadPicks(w).then(() => drawPicks(document, w));
      const { parts, params } = parseHash();
      if (parts[0] === 'blog' && parts[1] === 'predictions') renderPredictions(params);
    });
  }

  // ---------- Predictions tab: the leaderboard ----------
  // Every pick in a locked week, scored against the results: ESPN's in-league results, and the higher score
  // for cross-league games once the week is over. Picks on anything that isn't a real game don't count.
  async function predictionData() {
    const [locks, rows, fav, leagues, file] = await Promise.all([
      PICKS.locks(), PICKS.tallies(), PICKS.favorites(), loadAllLeagues(), lockedStandings(),
    ]);
    const [results, cross] = await Promise.all([
      Promise.all(leagues.map((l) => ESPN.getResults(l))),
      file ? lockedCrossSchedules(file) : crossSchedules(),
    ]);
    const currentWeek = Math.max(...leagues.map((l) => l.currentWeek));
    const scores = new Map(); // 'week|ref' -> points
    const games = new Map(); // 'week|game' -> { week, a, b, winner, leader, kind }
    leagues.forEach((l, i) => {
      for (const [teamId, list] of results[i]) for (const e of list) scores.set(`${e.week}|${l.slug}.${teamId}`, e.pf);
    });
    // The week being played: ESPN's season results don't have its live scores, so read them from the scoreboard.
    if (locks.has(currentWeek)) {
      const live = await Promise.all(leagues.map((l) => ESPN.getMatchups(l, currentWeek).catch(() => null)));
      leagues.forEach((l, i) => {
        for (const g of (live[i] && live[i].games) || []) {
          for (const s of [g.home, g.away]) if (s && s.team) scores.set(`${currentWeek}|${l.slug}.${s.team.id}`, s.score);
        }
      });
    }
    const score = (week, ref) => scores.get(`${week}|${ref}`) || 0;
    leagues.forEach((l, i) => {
      for (const [teamId, list] of results[i]) {
        for (const e of list) {
          if (e.bye || !e.opp) continue;
          const a = `${l.slug}.${teamId}`;
          const b = `${l.slug}.${e.opp.id}`;
          const game = pickGame(a, b, false);
          if (games.has(`${e.week}|${game}`)) continue;
          const winner = e.result == null ? null : e.result === 'T' ? 'tie' : e.result === 'W' ? a : b;
          const pa = score(e.week, a), pb = score(e.week, b);
          games.set(`${e.week}|${game}`, { week: e.week, game, a, b, winner, kind: l.slug, leader: pa > pb ? a : pb > pa ? b : null });
        }
      }
    });
    for (const [key, list] of cross.byTeam) {
      for (const x of list) {
        if (!x.opp || x.opp.missing || !x.opp.team) continue;
        const a = key.replace(':', '.');
        const b = `${x.opp.league.slug}.${x.opp.team.id}`;
        const game = pickGame(a, b, true);
        if (games.has(`${x.week}|${game}`)) continue;
        const pa = score(x.week, a), pb = score(x.week, b);
        const leader = pa > pb ? a : pb > pa ? b : null;
        const winner = x.week < currentWeek ? leader || 'tie' : null;
        games.set(`${x.week}|${game}`, { week: x.week, game, a, b, winner, leader, kind: 'x' });
      }
    }

    // Matchups of the Week score double. They're picked as on the cards: by standings going into the week, in
    // each league and across Cross-League. Week 1 has no standings yet, so no game scores double.
    const motw = new Set();
    const pickedWeeks = [...new Set(rows.map((r) => r.week))].filter((w) => w > 1 && locks.has(w));
    if (pickedWeeks.length) {
      const o = file ? null : await overallRecords();
      const boards = leagues.map((l) => {
        const copy = Object.assign({}, l, { teams: l.teams.map((t) => Object.assign({}, t)) });
        if (file) applyLocked(copy, file.leagues[l.slug]);
        else applyOverall(copy, o.out);
        return copy;
      });
      const side = (ref) => ({ league: { slug: ref.split('.')[0] }, team: { id: Number(ref.split('.')[1]) } });
      const asCards = (list) => list.map((g) => ({ id: g.game, home: side(g.a), away: side(g.b) }));
      for (const w of pickedWeeks) {
        const weekGames = [...games.values()].filter((g) => g.week === w);
        boards.forEach((l, i) => {
          const going = standingsGoingInto(l, results[i], w);
          const list = weekGames.filter((g) => g.kind === l.slug);
          if (!going || !list.length) return;
          const top = pickTopRanked(asCards(list), (s) => (going.get(s.team.id) || {}).rank || 99);
          if (top) motw.add(`${w}|${top}`);
        });
        const overall = await overallGoingInto(w);
        const rank = (s) => (overall.get(`${s.league.slug}:${s.team.id}`) || {}).rank;
        const ranked = asCards(weekGames.filter((g) => g.kind === 'x')).filter((g) => rank(g.home) && rank(g.away));
        const top = ranked.length && pickTopRanked(ranked, rank);
        if (top) motw.add(`${w}|${top}`);
      }
    }

    // Each member's points, overall and by week.
    const blank = () => ({ pts: 0, right: 0, wrong: 0, dogs: 0, picks: 0, live: 0 });
    const members = new Map();
    for (const r of rows) {
      const g = games.get(`${r.week}|${r.game}`);
      if (!g || (r.pick !== g.a && r.pick !== g.b)) continue;
      const saved = fav && fav.season === SEASON && fav.weeks && fav.weeks[r.week];
      const worth = pickWorth(saved && saved.proj, r.pick, r.pick === g.a ? g.b : g.a, motw.has(`${r.week}|${r.game}`));
      for (const id of r.managers) {
        if (!members.has(id)) members.set(id, { id, total: blank(), weeks: new Map() });
        const m = members.get(id);
        if (!m.weeks.has(r.week)) m.weeks.set(r.week, blank());
        for (const s of [m.total, m.weeks.get(r.week)]) {
          s.picks++;
          if (g.winner === r.pick) { s.pts += worth; s.right++; if (worth === 2) s.dogs++; }
          else if (g.winner && g.winner !== 'tie') s.wrong++;
          else if (!g.winner && g.leader === r.pick) s.live += worth;
        }
      }
    }
    // Who each manager is this season, by the manager id (their name as a slug).
    const teams = new Map();
    for (const l of leagues) for (const t of l.teams) teams.set(slugify(t.owner), { team: t, league: l });
    return { locks, games, members, teams, currentWeek, leagues };
  }

  async function renderPredictions(params) {
    const token = renderToken;
    const el = document.getElementById('league-body');
    try {
      const d = await predictionData();
      if (token !== renderToken) return;
      const now = Date.now();
      const lockedWeeks = [...d.locks].filter(([, at]) => at <= now).map(([w]) => w);
      const playedWeeks = lockedWeeks.filter((w) => [...d.members.values()].some((m) => m.weeks.has(w)));
      const asked = Number(params.get('week'));
      const week = playedWeeks.includes(asked) ? asked : null; // null: the whole season
      const next = [...d.locks].filter(([, at]) => at > now).sort((a, b) => a[1] - b[1])[0];
      const live = lockedWeeks.includes(d.currentWeek) && [...d.games.values()].some((g) => g.week === d.currentWeek && !g.winner)
        ? d.currentWeek : null;

      // This week: when picks lock, and how many the member has made in each section.
      let status = '';
      if (next) {
        const [nw, at] = next;
        const left = at - now;
        const inText = left < 3600e3 ? `${Math.max(1, Math.round(left / 60000))} min` : left < 86400e3
          ? `${Math.floor(left / 3600e3)}h ${Math.round((left % 3600e3) / 60000)}m` : `${Math.floor(left / 86400e3)}d ${Math.floor((left % 86400e3) / 3600e3)}h`;
        const weekGames = [...d.games.values()].filter((g) => g.week === nw);
        let progress = '';
        if (canReact()) {
          await PICKS.mine(nw);
          if (token !== renderToken) return;
          const mine = PICKS.state.mine.get(nw) || new Map();
          const sections = [...LEAGUES.map((l) => ({ kind: l.slug, name: l.name, href: `#/${l.slug}/matchups?week=${nw}`, theme: l.theme })),
            { kind: 'x', name: 'Cross-League', href: `#/cross-league?week=${nw}` }];
          const made = weekGames.filter((g) => mine.has(g.game)).length;
          progress = `
            <p class="pk-progress"><b>${made}</b> of ${weekGames.length} games picked</p>
            <div class="pk-links">${sections.map((s) => {
              const list = weekGames.filter((g) => g.kind === s.kind);
              const n = list.filter((g) => mine.has(g.game)).length;
              return `<a class="pk-link${list.length && n === list.length ? ' done' : ''}" href="${s.href}">${s.theme ? `<i class="dot" style="--c:var(--${s.theme})"></i>` : ''}${esc(s.name)} <b>${n}/${list.length}</b></a>`;
            }).join('')}</div>`;
        } else {
          const s = ACCOUNT.state;
          progress = `<p class="pk-progress">${!s.user ? 'Managers sign in to make picks.' : 'Link your team to make picks.'} <a href="#/account">${!s.user ? 'Sign in' : 'Link your team'}</a></p>`;
        }
        status = `
          <section class="panel pk-status">
            <div class="pk-when">
              <p class="eyebrow">Week ${nw} picks</p>
              <h2>Lock ${esc(new Date(at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</h2>
              <p class="muted">In ${inText}, at the week’s first kickoff. Pick each game on the Matchups and Cross-League tabs.</p>
            </div>
            ${progress}
          </section>`;
      }

      // The table: the season, or one week.
      const rows = [...d.members.values()].map((m) => {
        const s = week ? m.weeks.get(week) : m.total;
        return s && { m, s, liveWeek: live ? m.weeks.get(live) : null };
      }).filter(Boolean).sort((a, b) => b.s.pts - a.s.pts || b.s.right - a.s.right || a.s.wrong - b.s.wrong
        || (d.teams.get(a.m.id) || { team: { owner: a.m.id } }).team.owner.localeCompare((d.teams.get(b.m.id) || { team: { owner: b.m.id } }).team.owner));
      let rank = 0;
      const meId = canReact() ? ACCOUNT.state.me.manager_id : null;
      const showLive = live && (!week || week === live);
      const body = rows.map((r, i) => {
        if (i === 0 || r.s.pts !== rows[i - 1].s.pts || r.s.right !== rows[i - 1].s.right || r.s.wrong !== rows[i - 1].s.wrong) rank = i + 1;
        const who = d.teams.get(r.m.id);
        const league = who && LEAGUES.find((l) => l.slug === who.league.slug);
        const lw = r.liveWeek;
        return `
          <tr class="${r.m.id === meId ? 'me' : ''}">
            <td class="c-rank"><span class="rank">${rank}</span></td>
            <td class="c-team">${who ? `<a class="team-cell" href="#/${who.league.slug}/rosters?team=${who.team.id}">
              ${teamLogo(who.team, league, 'avatar')}<span><strong>${esc(who.team.owner)}</strong><small>${esc(who.team.name)} · ${esc(league.name)}</small></span></a>`
              : `<span class="team-cell"><span><strong>${esc(managerName(r.m.id))}</strong></span></span>`}</td>
            <td class="c-num pk-pts">${r.s.pts}</td>
            <td class="c-num">${r.s.right}-${r.s.wrong}</td>
            <td class="c-num hide-sm">${r.s.dogs}</td>
            ${showLive ? `<td class="c-num pk-live">${lw ? `+${lw.live}` : '—'}</td>` : ''}
          </tr>`;
      }).join('');
      const options = [`<option value="">Season</option>`, ...playedWeeks.slice().sort((a, b) => b - a)
        .map((w) => `<option value="${w}" ${w === week ? 'selected' : ''}>Week ${w}${w === live ? ' · live' : ''}</option>`)].join('');
      const table = rows.length ? `
        <div class="panel table-wrap">
          <table class="standings pk-table">
            <thead><tr>
              <th class="c-rank">#</th><th>Manager</th>
              <th class="c-num" title="1 per correct favorite, 2 per correct underdog">Pts</th>
              <th class="c-num" title="Correct picks - missed picks (ties count for neither)">Record</th>
              <th class="c-num hide-sm" title="Correct underdog picks">Upsets</th>
              ${showLive ? `<th class="c-num" title="Week ${live}: points if every game ended now">Wk ${live} live</th>` : ''}
            </tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>` : `<div class="state"><strong>No locked picks yet.</strong><span>${next ? `The leaderboard starts when Week ${next[0]} locks.` : 'Check back next season.'}</span></div>`;

      el.innerHTML = `
        ${status}
        <section class="pk-board">
          <div class="matchups-bar">
            <h2 class="section-label">${week ? `Week ${week} leaderboard` : 'Season leaderboard'}</h2>
            ${playedWeeks.length ? `<label class="select"><span class="sr-only">Choose week</span><select id="pk-week">${options}</select></label>` : ''}
          </div>
          ${table}
        </section>
        <p class="fineprint">Pick the winner of every in-league and cross-league game, including bye-week matchups, on the Matchups and Cross-League tabs (regular season, Weeks 1-14). You can change a pick until the week’s first NFL game kicks off; then picks lock, and everyone’s become public. A correct pick of the favorite is worth 1 point and a correct underdog 2. The favorite is the team with the higher max projected lineup at kickoff: the best lineup its roster could start, by ESPN’s projections. Even projections make both teams worth 1. Each Matchup of the Week (one per league and one in Cross-League, from Week 2 on) is worth double: 2 for the favorite, 4 for the underdog. A tie earns no points. Ranked by points, then correct picks.</p>`;
      const sel = el.querySelector('#pk-week');
      if (sel) sel.addEventListener('change', (e) => { location.hash = `#/blog/predictions${e.target.value ? `?week=${e.target.value}` : ''}`; });
    } catch (err) {
      console.error(err);
      if (token === renderToken) el.innerHTML = '<div class="state state-error" role="alert"><strong>Couldn’t load the leaderboard.</strong><span>Try again in a moment.</span></div>';
    }
  }

  // ---------- Main Blog: posts ----------
  // attach: the picture waiting in the post box ({ kind: 'image', blob, preview, w, h } or { kind: 'gif', url,
  // preview, w, h }). gif: the open GIF search ({ q, items, loading, error }), or null.
  // replies: post id -> its replies, oldest first. expanded: posts showing every reply (otherwise the last 3).
  // replying: the post whose reply box is open. seenAt: when the member last opened the Main Blog before this
  // visit (ms), so newer posts get a "New" divider; seenFor: whose visit that was.
  let feed = {
    posts: [], done: false, draft: '', editing: null, busy: false, msg: '', attach: null, gif: null,
    replies: new Map(), expanded: new Set(), replying: null, replyDrafts: new Map(), seenAt: null, seenFor: null,
  };
  const relTime = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };
  // ---------- @mentions ----------
  // "@Name" in a post or reply links to that manager's roster, and the post stands out for the manager it names.
  // Names are this season's managers (feedTeams), longest first so "@Hoai-Nha" wins over a shorter name.
  let mentionNames = []; // [{ name, league, id, team, logo }]
  let mentionRe = null;
  function setMentionNames() {
    mentionNames = [...feedTeams.entries()].map(([key, t]) => ({ name: t.owner, league: key.split(':')[0], id: t.id, team: t.name, logo: t.logo }))
      .filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
    const alts = mentionNames.map((m) => esc(m.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    mentionRe = alts.length ? new RegExp(`(^|[^\\w@])@(${alts.join('|')})(?![\\w-])`, 'gi') : null;
  }
  const findMention = (name) => mentionNames.find((m) => esc(m.name).toLowerCase() === name.toLowerCase());
  const myName = () => (canReact() ? ACCOUNT.state.me.name.toLowerCase() : null);
  function mentionsMe(body) {
    const me = myName();
    if (!me || !mentionRe || !body) return false;
    return [...esc(body).matchAll(mentionRe)].some((m) => m[2].toLowerCase() === esc(me));
  }

  // Text as written: line breaks kept, links and @mentions clickable, nothing else interpreted.
  function postText(s) {
    let html = esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,!?)'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
    if (mentionRe) {
      const me = myName();
      html = html.split(/(<a [^>]*>[\s\S]*?<\/a>)/).map((part, i) => (i % 2 ? part : part.replace(mentionRe, (all, pre, name) => {
        const m = findMention(name);
        if (!m) return all;
        return `${pre}<a class="mention${me && m.name.toLowerCase() === me ? ' me' : ''}" href="#/${m.league}/rosters?team=${m.id}">@${esc(m.name)}</a>`;
      }))).join('');
    }
    return html.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }

  // A post's picture, at its own shape and up to 420px tall. The space is saved before it loads, so the
  // scroll box doesn't jump. Tapping it opens the full picture.
  const GIPHY_HOST = /^https:\/\/(media[0-9]?|i)\.giphy\.com\//;
  // Pictures and GIFs are at most --media-h tall (css/styles.css: shorter on phones), never wider than they are.
  function mediaImg(src, w, h, alt) {
    return `<img src="${esc(src)}" alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async"
      style="aspect-ratio:${w}/${h};max-width:min(100%, ${w}px, calc(var(--media-h) * ${Math.round((w / h) * 1000) / 1000}))">`;
  }
  function postMedia(p) {
    if (!p.media || !p.media_w || !p.media_h) return '';
    const gif = p.media_kind === 'gif';
    if (gif && !GIPHY_HOST.test(p.media)) return '';
    const src = gif ? p.media : ACCOUNT.mediaUrl(p.media);
    const alt = gif ? `GIF posted by ${p.name}` : `Picture posted by ${p.name}`;
    return `<a class="post-media" href="${esc(src)}" target="_blank" rel="noopener noreferrer">${mediaImg(src, p.media_w, p.media_h, alt)}</a>`;
  }

  // A chosen photo, ready to upload: photos shrink to 1600px on the long side (WebP, or JPEG where the browser
  // can't make WebP); GIFs stay as they are so they keep moving. The bucket takes up to 5 MB.
  const MEDIA_LIMIT = 5 * 1024 * 1024;
  async function preparePostImage(file) {
    if (!/^image\//.test(file.type)) throw new Error('That file isn’t a picture.');
    if (file.size > 30 * 1024 * 1024) throw new Error('That picture is over 30 MB. Try a smaller one.');
    const url = URL.createObjectURL(file);
    try {
      const im = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('That file couldn’t be opened as a picture.'));
        i.src = url;
      });
      const w0 = im.naturalWidth, h0 = im.naturalHeight;
      if (file.type === 'image/gif') {
        if (file.size > MEDIA_LIMIT) throw new Error('GIFs can be up to 5 MB. Try a smaller one, or find it in the GIF search.');
        return { blob: file, w: w0, h: h0 };
      }
      const scale = Math.min(1, 1600 / Math.max(w0, h0));
      const c = document.createElement('canvas');
      c.width = Math.round(w0 * scale);
      c.height = Math.round(h0 * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im, 0, 0, c.width, c.height);
      const make = (type, q) => new Promise((r) => c.toBlob(r, type, q));
      let blob = await make('image/webp', 0.85);
      if (!blob || blob.type !== 'image/webp') blob = await make('image/jpeg', 0.85);
      if (blob.size > MEDIA_LIMIT) blob = await make(blob.type, 0.6);
      if (blob.size > MEDIA_LIMIT) throw new Error('That picture is too big even after shrinking it.');
      return { blob, w: c.width, h: c.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- GIF search (GIPHY) ----------
  // A beta GIPHY key allows 100 searches an hour for the whole site, so searches wait for a pause in typing
  // and repeat searches come from memory.
  const GIPHY_KEY = (window.MGDX && window.MGDX.GIPHY_KEY) || '';
  const gifCache = new Map();
  let gifTimer = 0;
  async function searchGifs(q) {
    const key = q.trim().toLowerCase();
    if (gifCache.has(key)) return gifCache.get(key);
    const params = new URLSearchParams({ api_key: GIPHY_KEY, limit: '24', rating: 'pg-13' });
    if (key) params.set('q', key);
    const r = await fetch(`https://api.giphy.com/v1/gifs/${key ? 'search' : 'trending'}?${params}`);
    if (r.status === 429) throw new Error('The GIF search is busy. Try again in a bit.');
    if (!r.ok) throw new Error('The GIF search isn’t working right now.');
    const { data } = await r.json();
    const items = (data || []).map((g) => {
      const full = g.images && (g.images.downsized || g.images.fixed_height);
      const thumb = g.images && (g.images.fixed_width_small || g.images.fixed_width || full);
      if (!full || !thumb || !GIPHY_HOST.test(full.url)) return null;
      return { url: full.url, w: Number(full.width), h: Number(full.height), thumb: thumb.url, title: g.title || 'GIF' };
    }).filter((g) => g && g.w && g.h);
    gifCache.set(key, items);
    return items;
  }
  function gifGrid() {
    const g = feed.gif;
    if (g.error) return `<p class="gif-note error">${esc(g.error)}</p>`;
    if (g.loading && !g.items.length) return '<p class="gif-note">Loading GIFs…</p>';
    if (!g.items.length) return '<p class="gif-note">No GIFs found. Try other words.</p>';
    return g.items.map((it, i) => `<button type="button" class="gif-pick" data-gif="${i}" title="${esc(it.title)}" aria-label="${esc(it.title)}">
      <img src="${esc(it.thumb)}" alt="" loading="lazy"></button>`).join('');
  }
  async function runGifSearch(q) {
    feed.gif = { ...feed.gif, q, loading: true, error: '' };
    const grid = document.querySelector('.gif-grid');
    if (grid && !gifCache.has(q.trim().toLowerCase())) grid.innerHTML = gifGrid();
    try {
      const items = await searchGifs(q);
      if (!feed.gif || feed.gif.q !== q) return; // a newer search took over, or the picker closed
      feed.gif = { ...feed.gif, items, loading: false };
    } catch (err) {
      if (!feed.gif || feed.gif.q !== q) return;
      feed.gif = { ...feed.gif, items: [], loading: false, error: err.message };
    }
    const g2 = document.querySelector('.gif-grid');
    if (g2) { g2.innerHTML = gifGrid(); g2.scrollTop = 0; }
  }

  // The author's team logo (the league seal for a manager who has left).
  function authorLogo(p, cls = 'avatar') {
    const league = LEAGUES.find((l) => l.slug === p.league);
    return league ? teamLogo({ id: p.team_id, logo: (feedTeams.get(`${p.league}:${p.team_id}`) || {}).logo }, league, cls)
      : `<img class="${cls}" src="assets/img/mgdx-shield.png?v=3" alt="">`;
  }
  const when = (p) => `<time datetime="${esc(p.created_at)}" title="${esc(new Date(p.created_at).toLocaleString())}">${relTime(p.created_at)}</time>${p.edited_at ? ' · edited' : ''}`;
  // Written by someone else since the member's last visit.
  const isNew = (p) => Boolean(feed.seenAt && Date.parse(p.created_at) > feed.seenAt
    && !(canReact() && p.manager_id === ACCOUNT.state.me.manager_id));
  function postTools(p, editing) {
    const me = canReact() ? ACCOUNT.state.me : null;
    const mine = me && me.manager_id === p.manager_id;
    if (!mine && !(me && me.moderator)) return '';
    return `<div class="post-tools">
      ${mine && !editing ? '<button type="button" class="btn-quiet" data-post-act="edit">Edit</button>' : ''}
      <button type="button" class="btn-quiet danger" data-post-act="delete">Delete</button>
    </div>`;
  }
  function editForm(p, label, rows) {
    return `
      <form class="post-form" data-post-act="save">
        <label class="sr-only" for="edit-${p.id}">${label}</label>
        <textarea id="edit-${p.id}" name="body" maxlength="2000" rows="${rows}"${p.media ? '' : ' required'}>${esc(p.body)}</textarea>
        <div class="post-form-row"><span></span><div class="logo-actions">
          <button type="button" class="btn-quiet" data-post-act="cancel">Cancel</button>
          <button type="submit" class="btn">Save</button></div></div>
      </form>`;
  }

  function postCard(p) {
    const league = LEAGUES.find((l) => l.slug === p.league);
    const editing = feed.editing === p.id;
    return `
      <article class="panel post${mentionsMe(p.body) ? ' mentioned' : ''}" data-post="${p.id}" style="${league ? `--lc:var(--${league.theme})` : ''}">
        <header class="post-head">
          ${authorLogo(p)}
          <div class="post-who">
            <b>${esc(p.name)}</b>
            <small>${league ? `<a href="#/${league.slug}/rosters?team=${p.team_id}">${esc(p.team_name)}</a> · ${esc(league.name)} · ` : ''}${when(p)}</small>
          </div>
          ${postTools(p, editing)}
        </header>
        ${editing ? editForm(p, 'Edit your post', 4) : p.body ? `<div class="post-body">${postText(p.body)}</div>` : ''}
        ${postMedia(p)}
        ${reactBar(`post:${p.id}`)}
        ${repliesBlock(p)}
      </article>`;
  }

  // Replies sit under their post, oldest first; a long thread shows its last 3 until opened.
  function replyItem(r) {
    const editing = feed.editing === r.id;
    return `
      <div class="reply${mentionsMe(r.body) ? ' mentioned' : ''}" data-post="${r.id}">
        ${authorLogo(r, 'avatar')}
        <div class="reply-main">
          <div class="reply-head">
            <span class="reply-who"><b>${esc(r.name)}</b> <small>${when(r)}</small>${isNew(r) ? ' <span class="new-tag">New</span>' : ''}</span>
            ${postTools(r, editing)}
          </div>
          ${editing ? editForm(r, 'Edit your reply', 2) : `<div class="post-body">${postText(r.body)}</div>`}
        </div>
      </div>`;
  }
  function repliesBlock(p) {
    const list = feed.replies.get(p.id) || [];
    const member = canReact();
    if (!list.length && !member) return '';
    const shown = feed.expanded.has(p.id) ? list : list.slice(-3);
    const hidden = list.length - shown.length;
    const box = !member ? '' : feed.replying === p.id ? `
      <form class="post-form reply-form" data-post-act="reply">
        <label class="sr-only" for="reply-${p.id}">Reply to ${esc(p.name)}</label>
        <textarea id="reply-${p.id}" name="body" maxlength="2000" rows="2" placeholder="Reply to ${esc(p.name)}… (@ to mention)" required>${esc(feed.replyDrafts.get(p.id) || '')}</textarea>
        <div class="post-form-row"><span></span><div class="logo-actions">
          <button type="button" class="btn-quiet" data-post-act="reply-cancel">Cancel</button>
          <button type="submit" class="btn">Reply</button></div></div>
      </form>` : '<button type="button" class="btn-quiet reply-open" data-post-act="reply-open">Reply</button>';
    return `
      <div class="replies${list.length ? '' : ' empty'}">
        ${hidden ? `<button type="button" class="btn-quiet reply-more" data-post-act="replies-all">View ${hidden} earlier ${hidden === 1 ? 'reply' : 'replies'}</button>` : ''}
        ${shown.map(replyItem).join('')}
        ${box}
      </div>`;
  }

  // The replies to these posts (only those that have any), into feed.replies.
  async function loadReplies(posts) {
    const ids = posts.filter((p) => p.replies > 0).map((p) => p.id);
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const rows = await ACCOUNT.read('list_replies', { p_parents: batch });
      for (const id of batch) feed.replies.set(id, []);
      for (const r of rows) feed.replies.get(r.parent_id).push(r);
    }
  }
  // A post or reply by id, with the post it belongs to.
  function findPost(id) {
    const post = feed.posts.find((x) => x.id === id);
    if (post) return { item: post, post };
    for (const [pid, list] of feed.replies) {
      const item = list.find((r) => r.id === id);
      if (item) return { item, post: feed.posts.find((x) => x.id === pid) };
    }
    return null;
  }
  // Redraws one post (and its replies) in place, keeping it at the same spot in the scroll box.
  function redrawPost(id, focusId) {
    const el = document.querySelector(`.post[data-post="${CSS.escape(id)}"]`);
    const p = feed.posts.find((x) => x.id === id);
    const box = document.querySelector('.post-scroll');
    if (!el || !p || !box) return drawFeed();
    const top = el.getBoundingClientRect().top;
    const activeId = focusId || (document.activeElement && document.activeElement.id);
    el.outerHTML = postCard(p);
    const now = box.querySelector(`.post[data-post="${CSS.escape(id)}"]`);
    box.scrollTop += now.getBoundingClientRect().top - top;
    refocus(activeId);
    hydrateReactions(now);
  }

  let feedTeams = new Map(); // 'league:teamId' -> this season's team (for ESPN logos)
  function composer() {
    if (!canReact()) {
      const s = ACCOUNT.state;
      return `<div class="panel post-gate"><p>${!s.user ? 'Managers can post here and react to posts, recaps and matchups.' : 'Link your team to post and react.'}</p>
        <a class="btn" href="#/account">${!s.user ? 'Sign in' : 'Link your team'}</a></div>`;
    }
    const n = feed.draft.length;
    const a = feed.attach;
    const attached = a ? `
      <div class="post-attach">
        ${mediaImg(a.preview, a.w, a.h, a.kind === 'gif' ? 'The GIF you picked' : 'The picture you picked')}
        <button type="button" class="post-attach-x" data-post-act="unattach" aria-label="Remove the ${a.kind === 'gif' ? 'GIF' : 'picture'}" title="Remove"${feed.busy ? ' disabled' : ''}>✕</button>
      </div>` : '';
    const picker = feed.gif ? `
      <div class="gif-picker">
        <label class="sr-only" for="gif-q">Search GIFs</label>
        <input id="gif-q" type="search" placeholder="Search GIFs" value="${esc(feed.gif.q)}" autocomplete="off" enterkeyhint="search">
        <div class="gif-grid" aria-live="polite">${gifGrid()}</div>
        <div class="gif-foot"><small>Powered by GIPHY</small><button type="button" class="btn-quiet" data-post-act="gif-close">Close</button></div>
      </div>` : '';
    const PHOTO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    return `<form class="panel post-form composer" data-post-act="create">
      <label class="sr-only" for="post-body">Write a post</label>
      <textarea id="post-body" name="body" maxlength="2000" rows="1" placeholder="Takes, trash talk… (@ to mention)">${esc(feed.draft)}</textarea>
      ${attached}${picker}
      <div class="post-form-row">
        <div class="post-tools-left">
          <label class="btn-quiet post-add${a || feed.busy ? ' off' : ''}" title="Add a photo or GIF from your device">${PHOTO}<span>Photo</span>
            <input id="post-file" type="file" accept="image/*" aria-label="Add a photo or GIF from your device"${a || feed.busy ? ' disabled' : ''}></label>
          ${GIPHY_KEY ? `<button type="button" class="btn-quiet post-add" data-post-act="gif" aria-label="Search GIFs" aria-expanded="${Boolean(feed.gif)}"${a || feed.busy ? ' disabled' : ''}><b class="gif-badge">GIF</b></button>` : ''}
          <small class="post-count${n > 1800 ? ' near' : ''}">${n ? `${n} / 2,000` : ''}</small>
        </div>
        <button type="submit" class="btn"${feed.busy ? ' disabled' : ''}>${feed.busy ? 'Posting…' : 'Post'}</button>
      </div>
      ${feed.msg ? `<p class="acct-msg error" role="alert">${esc(feed.msg)}</p>` : ''}
    </form>`;
  }

  // Like a chat: oldest at the top, newest at the bottom right above the post box. The posts scroll in their
  // own box, which opens at the bottom; scrolling to its top loads the next 20 older posts.
  // Each redraw keeps the same distance from the bottom, so older posts appear above without a jump.
  function drawFeed(toBottom) {
    const el = document.getElementById('league-body');
    if (!el || !el.classList.contains('feed-body')) return;
    const old = el.querySelector('.post-scroll');
    const fromBottom = toBottom || !old ? 0 : old.scrollHeight - old.scrollTop;
    const activeId = document.activeElement && document.activeElement.id;
    const top = !feed.posts.length ? ''
      : feed.done ? '<p class="post-start">The beginning of the blog</p>'
      : `<div class="post-more"><button type="button" class="btn-quiet" data-post-act="more"${feed.loadingOlder ? ' disabled' : ''}>${feed.loadingOlder ? 'Loading older posts…' : 'Load older posts'}</button></div>`;
    el.innerHTML = `
      <div class="post-scroll" tabindex="0" aria-label="Posts, oldest first">
        ${top}
        <div class="post-list">${feed.posts.length ? feed.posts.slice().reverse().map((p, i, all) =>
          (isNew(p) && !all.slice(0, i).some(isNew) ? '<div class="post-new" role="separator"><span>New since your last visit</span></div>' : '') + postCard(p)).join('')
          : '<div class="state"><strong>No posts yet.</strong><span>Be the first to talk some trash.</span></div>'}</div>
      </div>
      ${composer()}`;
    const box = el.querySelector('.post-scroll');
    fitFeed();
    box.scrollTop = fromBottom ? box.scrollHeight - fromBottom : box.scrollHeight;
    box.addEventListener('scroll', () => { if (box.scrollTop < 120) loadOlder(); }, { passive: true });
    refocus(activeId);
    hydrateReactions(el);
    // Fewer posts than fill the box: keep loading until it scrolls (or there are no more).
    if (!feed.done && box.scrollHeight <= box.clientHeight) loadOlder();
  }

  // The posts box fills the screen between the pinned site header and the post box, so both fit at once.
  // scrollPage (opening the Main Blog) scrolls the page down to them, past the page title, when they don't
  // already fit.
  function fitFeed(scrollPage) {
    const el = document.getElementById('league-body');
    const box = el && el.querySelector('.post-scroll');
    const form = el && el.querySelector('.composer, .post-gate');
    if (!box || !form) return;
    const header = document.querySelector('.site-header');
    const pinned = header && /sticky|fixed/.test(getComputedStyle(header).position) ? header.offsetHeight : 0;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
    box.style.maxHeight = `${Math.round(Math.max(220, Math.min(900, innerHeight - pinned - form.offsetHeight - 40)))}px`;
    if (atBottom) box.scrollTop = box.scrollHeight;
    if (scrollPage) {
      const bottom = form.getBoundingClientRect().bottom + scrollY + 14;
      if (bottom > scrollY + innerHeight) window.scrollTo({ top: bottom - innerHeight, behavior: 'instant' });
    }
  }
  let fitTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitFeed(), 150); });
  // The post box grows with what's typed (up to a point), and the posts box makes room for it.
  function growComposer(ta) {
    ta.style.height = ''; // back to its usual size, then taller only if the text needs it
    if (ta.scrollHeight > ta.clientHeight) ta.style.height = `${Math.min(ta.scrollHeight + 2, Math.round(innerHeight * 0.3))}px`;
    fitFeed();
  }

  // Typing spots keep focus (and the cursor at the end) through a redraw.
  function refocus(id) {
    if (!id || !/^(post-body|gif-q|reply-|edit-)/.test(id)) return;
    const t = document.getElementById(id);
    if (!t) return;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length);
  }
  // Redraws just the post box (a picture added or removed, the GIF search opened), leaving the posts alone.
  function redrawComposer(focusId) {
    const form = document.querySelector('.composer');
    if (!form) return drawFeed();
    const activeId = focusId || (document.activeElement && document.activeElement.id);
    form.outerHTML = composer();
    refocus(activeId);
  }
  const dropAttach = () => {
    if (feed.attach && feed.attach.kind === 'image') URL.revokeObjectURL(feed.attach.preview);
    feed.attach = null;
  };

  async function loadOlder() {
    if (feed.done || feed.loadingOlder || !feed.posts.length) return;
    feed.loadingOlder = true;
    const token = renderToken;
    const btn = document.querySelector('.post-more button');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading older posts…'; }
    try {
      const older = await ACCOUNT.read('list_posts', { p_before: feed.posts[feed.posts.length - 1].created_at, p_limit: 20 });
      await loadReplies(older);
      if (token !== renderToken) return;
      feed = { ...feed, posts: feed.posts.concat(older), done: older.length < 20, loadingOlder: false };
      // Slot them in above the posts already shown, keeping the box (and a swipe in progress) where it is.
      const box = document.querySelector('.post-scroll');
      const list = box && box.querySelector('.post-list');
      if (!list) return drawFeed();
      const fromBottom = box.scrollHeight - box.scrollTop;
      list.insertAdjacentHTML('afterbegin', older.slice().reverse().map(postCard).join(''));
      box.querySelector('.post-more, .post-start').outerHTML = feed.done ? '<p class="post-start">The beginning of the blog</p>'
        : '<div class="post-more"><button type="button" class="btn-quiet" data-post-act="more">Load older posts</button></div>';
      box.scrollTop = box.scrollHeight - fromBottom;
      hydrateReactions(box);
      if (!feed.done && box.scrollHeight <= box.clientHeight) loadOlder();
    } catch (err) {
      console.error(err);
      feed.loadingOlder = false;
    }
  }

  // fresh: a new visit to the Main Blog, which marks it read (after posting, the page reloads without that).
  async function renderFeed(fresh = true) {
    const token = renderToken;
    const el = document.getElementById('league-body');
    el.classList.add('feed-body');
    if (fresh) feed.seenFor = null;
    try {
      const [posts, standings] = await Promise.all([
        ACCOUNT.read('list_posts', { p_limit: 20 }),
        fetch('data/standings.json').then((r) => r.json()).catch(() => null),
        markSeen(),
      ]);
      feed.replies = new Map();
      await loadReplies(posts);
      if (token !== renderToken) return;
      feedTeams = new Map();
      for (const [slug, l] of Object.entries((standings && standings.leagues) || {})) for (const t of l.teams) feedTeams.set(`${slug}:${t.id}`, t);
      setMentionNames();
      feed = { ...feed, posts, done: posts.length < 20, editing: null, replying: fresh ? null : feed.replying, msg: '', loadingOlder: false };
      drawFeed(true);
      if (fresh) fitFeed(true);
    } catch (err) {
      console.error(err);
      if (token === renderToken) el.innerHTML = '<div class="state state-error" role="alert"><strong>Couldn’t load the posts.</strong><span>Try again in a moment.</span></div>';
    }
  }

  if (ACCOUNT && !ARCHIVE) {
    main.addEventListener('change', async (e) => {
      if (e.target.id !== 'post-file' || !e.target.files[0]) return;
      const file = e.target.files[0];
      feed.msg = '';
      try {
        const { blob, w, h } = await preparePostImage(file);
        dropAttach();
        feed.attach = { kind: 'image', blob, preview: URL.createObjectURL(blob), w, h };
        feed.gif = null;
      } catch (err) {
        feed.msg = err.message;
      }
      redrawComposer('post-body');
    });
    main.addEventListener('input', (e) => {
      if (e.target.id === 'gif-q') {
        const q = e.target.value;
        clearTimeout(gifTimer);
        if (!feed.gif) return;
        feed.gif.q = q;
        const t = q.trim();
        if (t.length === 1) return; // wait for a second letter
        gifTimer = setTimeout(() => { if (feed.gif && feed.gif.q === q) runGifSearch(q); }, gifCache.has(t.toLowerCase()) ? 0 : 450);
        return;
      }
      if (e.target.matches('.feed-body textarea')) showMentions(e.target);
      if (e.target.id.startsWith('reply-')) feed.replyDrafts.set(e.target.id.slice(6), e.target.value);
      if (e.target.id !== 'post-body') return;
      feed.draft = e.target.value;
      growComposer(e.target);
      const c = e.target.closest('form').querySelector('.post-count');
      if (c) { c.textContent = feed.draft.length ? `${feed.draft.length} / 2,000` : ''; c.classList.toggle('near', feed.draft.length > 1800); }
    });
    main.addEventListener('submit', async (e) => {
      const form = e.target.closest('form[data-post-act]');
      if (!form) return;
      e.preventDefault();
      const body = form.querySelector('textarea').value;
      const btn = form.querySelector('button[type=submit]');
      if (form.dataset.postAct === 'create' && !body.trim() && !feed.attach) {
        feed.msg = 'Write something or add a picture first.';
        return redrawComposer('post-body');
      }
      btn.disabled = true;
      let uploaded = null;
      try {
        if (form.dataset.postAct === 'create') {
          feed = { ...feed, busy: true, msg: '', gif: null };
          redrawComposer();
          const a = feed.attach;
          let media = {};
          if (a && a.kind === 'image') {
            uploaded = await ACCOUNT.uploadPostMedia(a.blob);
            media = { p_media_kind: 'image', p_media: uploaded, p_media_w: a.w, p_media_h: a.h };
          } else if (a) media = { p_media_kind: 'gif', p_media: a.url, p_media_w: a.w, p_media_h: a.h };
          notifyPost(await ACCOUNT.write('create_post', { p_body: body, ...media }));
          uploaded = null;
          dropAttach();
          feed = { ...feed, draft: '', busy: false };
        } else if (form.dataset.postAct === 'reply') {
          const id = form.closest('[data-post]').dataset.post;
          notifyPost(await ACCOUNT.write('create_post', { p_body: body, p_parent: id }));
          const rows = await ACCOUNT.read('list_replies', { p_parents: [id] });
          feed.replies.set(id, rows);
          const post = feed.posts.find((x) => x.id === id);
          if (post) post.replies = rows.length;
          feed.replyDrafts.delete(id);
          feed.replying = null;
          redrawPost(id);
          return;
        } else {
          // An edit changes one post or reply in place, keeping the older posts already loaded and the scroll spot.
          const id = form.closest('[data-post]').dataset.post;
          await ACCOUNT.write('edit_post', { p_id: id, p_body: body });
          const found = findPost(id);
          if (found) Object.assign(found.item, { body: body.trim(), edited_at: new Date().toISOString() });
          feed.editing = null;
          if (found) redrawPost(found.post.id); else drawFeed();
          return;
        }
        renderFeed(false); // a new post: reload the newest and land on it at the bottom
      } catch (err) {
        if (uploaded) ACCOUNT.removePostMedia(uploaded); // the post didn't save, so its picture shouldn't stay
        if (form.dataset.postAct === 'create') { feed = { ...feed, busy: false, msg: err.message }; drawFeed(); }
        else { btn.disabled = false; alert(err.message); }
      }
    });
    main.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-post-act]');
      if (!b || b.tagName === 'FORM') return;
      const act = b.dataset.postAct;
      const card = b.closest('[data-post]');
      const found = card && findPost(card.dataset.post);
      const postId = found && found.post && found.post.id;
      if (act === 'edit' && found) { feed.editing = card.dataset.post; redrawPost(postId, `edit-${card.dataset.post}`); }
      else if (act === 'cancel' && found) { feed.editing = null; redrawPost(postId); }
      else if (act === 'delete' && found) {
        const p = found.item;
        const reply = p !== found.post;
        const kind = reply ? 'reply' : 'post';
        const mine = ACCOUNT.state.me && p.manager_id === ACCOUNT.state.me.manager_id;
        if (!confirm(mine ? `Delete your ${kind}?` : `Delete ${p.name}’s ${kind}? This can’t be undone.`)) return;
        try {
          const file = await ACCOUNT.write('delete_post', { p_id: p.id });
          ACCOUNT.removePostMedia(file);
          if (reply) {
            feed.replies.set(postId, feed.replies.get(postId).filter((r) => r.id !== p.id));
            found.post.replies = feed.replies.get(postId).length;
            redrawPost(postId);
          } else {
            feed.posts = feed.posts.filter((x) => x.id !== p.id);
            feed.replies.delete(p.id);
            drawFeed();
          }
        } catch (err) { alert(err.message); }
      } else if (act === 'reply-open' && found) { feed.replying = postId; redrawPost(postId, `reply-${postId}`); }
      else if (act === 'reply-cancel' && found) { feed.replying = null; redrawPost(postId); }
      else if (act === 'replies-all' && found) { feed.expanded.add(postId); redrawPost(postId); }
      else if (act === 'more') loadOlder();
      else if (act === 'unattach') { dropAttach(); feed.msg = ''; redrawComposer('post-body'); }
      else if (act === 'gif') {
        if (feed.gif) { feed.gif = null; return redrawComposer('post-body'); }
        feed.gif = { q: '', items: [], loading: true, error: '' };
        redrawComposer('gif-q');
        runGifSearch('');
      } else if (act === 'gif-close') { feed.gif = null; redrawComposer('post-body'); }
    });
    main.addEventListener('click', (e) => {
      const b = e.target.closest('.gif-pick');
      if (!b || !feed.gif) return;
      const it = feed.gif.items[Number(b.dataset.gif)];
      if (!it) return;
      dropAttach();
      feed.attach = { kind: 'gif', url: it.url, preview: it.url, w: it.w, h: it.h };
      feed.gif = null;
      feed.msg = '';
      redrawComposer('post-body');
    });
    // Enter in the GIF search searches now instead of sending the post
    main.addEventListener('keydown', (e) => {
      if (e.target.id !== 'gif-q' || e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(gifTimer);
      if (feed.gif) runGifSearch(e.target.value);
    });
    // Signing in or out changes the composer and post tools.
    ACCOUNT.onChange(() => { if (onMainBlog()) markSeen().then(() => drawFeed()); });
  }

  // ---------- @mention suggestions ----------
  // Typing "@" and a few letters in a post, reply or edit box lists matching managers; arrows and Enter (or a tap)
  // fill in the name.
  let mentionUI = null; // { ta, start, list, active }
  function closeMentions() {
    const menu = document.querySelector('.mention-menu');
    if (menu) menu.remove();
    mentionUI = null;
  }
  function showMentions(ta) {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = /(^|[^\w@])@([\w-]{0,20})$/.exec(upto);
    if (!m || !mentionNames.length) return closeMentions();
    const q = m[2].toLowerCase();
    const list = mentionNames.filter((x) => x.name.toLowerCase().startsWith(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6);
    if (!list.length) return closeMentions();
    mentionUI = { ta, start: upto.length - m[2].length - 1, list, active: 0 };
    drawMentions();
  }
  function drawMentions() {
    let menu = document.querySelector('.mention-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'mention-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', 'Mention a manager');
      document.body.appendChild(menu);
    }
    const { ta, list, active } = mentionUI;
    menu.innerHTML = list.map((x, i) => {
      const league = LEAGUES.find((l) => l.slug === x.league);
      return `<button type="button" role="option" tabindex="-1" class="${i === active ? 'on' : ''}" aria-selected="${i === active}" data-mention="${i}">
        ${league ? teamLogo({ id: x.id, logo: x.logo }, league, 'avatar') : ''}<span><b>${esc(x.name)}</b><small>${esc(x.team)}</small></span></button>`;
    }).join('');
    // Below the box when there's room, otherwise above it (the post box sits at the bottom of the page).
    const r = ta.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${r.bottom + 4 + h <= innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
  }
  function pickMention(i) {
    const { ta, start, list } = mentionUI;
    const text = `@${list[i].name} `;
    const end = ta.selectionStart;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.focus();
    ta.setSelectionRange(start + text.length, start + text.length);
    closeMentions();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (ACCOUNT && !ARCHIVE) {
    main.addEventListener('keydown', (e) => {
      if (!mentionUI || e.target !== mentionUI.ta) return;
      const n = mentionUI.list.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mentionUI.active = (mentionUI.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        drawMentions();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mentionUI.active);
      } else if (e.key === 'Escape') closeMentions();
    }, true);
    // mousedown, not click, so the text box keeps focus
    document.addEventListener('mousedown', (e) => {
      const b = e.target.closest('.mention-menu [data-mention]');
      if (b && mentionUI) { e.preventDefault(); pickMention(Number(b.dataset.mention)); }
      else if (mentionUI && e.target !== mentionUI.ta) closeMentions();
    });
    main.addEventListener('focusout', (e) => { if (mentionUI && e.target === mentionUI.ta) setTimeout(() => { if (mentionUI && document.activeElement !== mentionUI.ta) closeMentions(); }, 0); });
    document.addEventListener('scroll', (e) => { if (mentionUI && !(e.target.closest && e.target.closest('.mention-menu'))) closeMentions(); }, { capture: true, passive: true });
    window.addEventListener('hashchange', closeMentions);
  }

  // ---------- unread posts ----------
  // A badge on the Blog tab (and Main Blog) counts posts and replies other managers wrote since the member last
  // opened the Main Blog; "@" when one mentions them. Checked on sign-in, every few minutes and on returning
  // to the tab. Opening the Main Blog marks everything read.
  const unread = { posts: 0, mentions: 0, who: null };
  const onMainBlog = () => { const { parts } = parseHash(); return parts[0] === 'blog' && (parts[1] || 'main') === 'main'; };
  function drawUnread() {
    const { posts: n, mentions: at } = unread;
    const text = at ? '@' : n ? (n > 9 ? '9+' : String(n)) : '';
    const title = at ? `${at} new mention${at > 1 ? 's' : ''}${n > at ? `, ${n} new in all` : ''}` : n ? `${n} new post${n > 1 ? 's' : ''} and replies` : '';
    document.querySelectorAll('[data-unread]').forEach((b) => {
      b.hidden = !text;
      b.textContent = text;
      b.title = title;
      b.classList.toggle('at', Boolean(at));
    });
    // The count on the installed app's icon, where the phone supports it.
    if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
  async function checkUnread() {
    if (!canReact()) { Object.assign(unread, { posts: 0, mentions: 0 }); return drawUnread(); }
    if (onMainBlog()) return; // the feed marks itself read
    try {
      const [r] = await ACCOUNT.write('unread_posts');
      Object.assign(unread, { posts: (r && r.posts) || 0, mentions: (r && r.mentions) || 0 });
      drawUnread();
    } catch (err) { console.warn('Unread posts unavailable', err); }
  }
  async function markSeen() {
    const me = canReact() ? ACCOUNT.state.me.manager_id : null;
    if (!me || feed.seenFor === me) return;
    feed.seenFor = me;
    try {
      const before = await ACCOUNT.write('mark_posts_seen');
      feed.seenAt = before ? Date.parse(before) : null;
    } catch (err) { console.warn('Couldn’t mark the blog read', err); }
    Object.assign(unread, { posts: 0, mentions: 0 });
    drawUnread();
  }
  if (ACCOUNT && ACCOUNT.enabled && !ARCHIVE) {
    const blogLink = document.querySelector('#main-nav a[data-route="blog"]');
    if (blogLink) blogLink.insertAdjacentHTML('beforeend', '<span class="nav-badge" data-unread hidden></span>');
    ACCOUNT.onChange(() => {
      const who = canReact() ? ACCOUNT.state.me.manager_id : null;
      if (who === unread.who) return;
      unread.who = who;
      checkUnread();
    });
    setInterval(() => { if (!document.hidden) checkUnread(); }, 180000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUnread(); });
    window.addEventListener('hashchange', () => { if (!onMainBlog()) setTimeout(drawUnread, 0); });
  }

  // ---------- account ----------
  // Sign in (Google or email and password), then link the account to a manager with a claim code.
  // window.MGDX_ACCOUNT comes from js/account.js, which only the current season's page loads.
  const CLAIM_ERRORS = {
    'bad-code': 'That code doesn’t match any manager. Check it and try again.',
    used: 'That code has already been used. If it’s yours, ask a moderator to reset it.',
    'not-current': `That code is for a manager who isn’t playing in ${SEASON}.`,
    'too-many': 'Too many tries. Wait an hour, then try again.',
    'signed-out': 'Sign in first, then enter your code.',
  };
  let accountMode = 'sign-in'; // or 'sign-up'
  let accountView = '';
  const GOOGLE_G = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  function renderAccount() {
    renderToken++;
    document.body.dataset.theme = 'home';
    document.title = 'Your Account · Microgen Fantasy Football';
    main.innerHTML = `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-seal.png?v=2" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow">Managers only</p>
          <h1 class="page-title">Your Account</h1>
        </div>
      </section>
      <div id="account-body"></div>`;
    accountView = '';
    drawAccount();
  }

  function drawAccount() {
    const el = document.getElementById('account-body');
    if (!el) return;
    const s = ACCOUNT ? ACCOUNT.state : { ready: true };
    // Only redraw when something shown changes, so a background token refresh doesn't wipe a half-typed form.
    const view = JSON.stringify([ACCOUNT && ACCOUNT.enabled, s.ready, s.user && s.user.id, s.me, s.recovery, s.link, s.error, accountMode]);
    if (view === accountView) return;
    accountView = view;
    const msg = s.error ? `<p class="acct-msg error" role="alert">${esc(s.error)}</p>` : '<p class="acct-msg" role="status"></p>';
    if (ACCOUNT) ACCOUNT.clearError();

    if (!ACCOUNT || !ACCOUNT.enabled) {
      el.innerHTML = `<section class="placeholder"><img class="placeholder-art" src="assets/img/mgdx-shield.png?v=3" alt="" width="220" height="220">
        <p class="eyebrow">Sign-in for managers</p><h2 class="page-title">Accounts</h2><p class="placeholder-badge">Coming soon</p></section>`;
      return;
    }
    if (!s.ready) { el.innerHTML = loading('Checking your account'); return; }

    if (s.link) {
      // From an email link: nothing happens until the person taps, so a mail service checking the link can't use it up.
      const reset = s.link === 'recovery';
      el.innerHTML = `<div class="panel acct-card">
        <h2>${reset ? 'Reset your password' : 'Confirm your email'}</h2>
        <p class="acct-lede">${reset ? 'Tap Continue to choose a new password.' : 'One more tap and your account is ready.'}</p>
        <button class="btn" type="button" data-act="use-link">${reset ? 'Continue' : 'Confirm my email'}</button>
        ${msg}</div>`;
    } else if (s.recovery) {
      el.innerHTML = `<div class="panel acct-card">
        <h2>Choose a new password</h2>
        <form class="acct-form" data-act="new-password">
          <label>New password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
          <button class="btn" type="submit">Save password</button>
        </form>${msg}</div>`;
    } else if (!s.user) {
      const up = accountMode === 'sign-up';
      el.innerHTML = `<div class="panel acct-card">
        <h2>${up ? 'Create your account' : 'Sign in'}</h2>
        <p class="acct-lede">For ${SEASON} MGDX managers. After signing in, you’ll enter the code you got from the league to link your account to your team.</p>
        <button class="acct-google" type="button" data-act="google">${GOOGLE_G}<span>Continue with Google</span></button>
        <p class="acct-or"><span>or with email</span></p>
        <form class="acct-form" data-act="${up ? 'sign-up' : 'sign-in'}">
          <label>Email<input type="email" name="email" autocomplete="email" required></label>
          <label>Password<input type="password" name="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="${up ? 8 : 1}" required></label>
          <button class="btn" type="submit">${up ? 'Create account' : 'Sign in'}</button>
        </form>
        ${msg}
        <p class="acct-links">
          ${up ? '<button type="button" data-act="mode">Already have an account? Sign in</button>'
            : '<button type="button" data-act="mode">New here? Create an account</button><button type="button" data-act="forgot">Forgot your password?</button><button type="button" data-act="resend">Resend the confirmation email</button>'}
        </p></div>`;
    } else if (!s.me) {
      el.innerHTML = `<div class="panel acct-card">
        <h2>Link your team</h2>
        <p class="acct-lede">Enter the code you got from the league. It links this account to your team, and only works once.</p>
        <form class="acct-form" data-act="claim">
          <label>Claim code<input name="code" class="acct-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="LR-XXXXXX" required></label>
          <button class="btn" type="submit">Link my team</button>
        </form>
        ${msg}
        <p class="acct-links"><span>Signed in as ${esc(s.user.email)}</span><button type="button" data-act="sign-out">Sign out</button></p></div>`;
    } else {
      const me = s.me;
      const league = LEAGUES.find((l) => l.slug === me.league);
      el.innerHTML = `<div class="panel acct-card">
        <div class="acct-who">
          ${league ? `<img class="avatar xl" id="acct-logo" src="${esc(league.logo)}" alt="">` : ''}
          <div>
            <h2>${esc(me.name)}${me.moderator ? ' <span class="acct-badge">Moderator</span>' : ''}</h2>
            ${league ? `<p><a href="#/${league.slug}/rosters?team=${me.team_id}">${esc(me.team_name)}</a> · ${esc(league.name)}</p>`
              : `<p>Not a manager in ${me.season}, so members-only features are off for this account.</p>`}
          </div>
        </div>
        ${league ? '<p class="acct-lede">You’re all set: post and react on the Blog, and make your picks in Predictions.</p>' : ''}
        ${msg}
        <p class="acct-links"><span>Signed in as ${esc(s.user.email)}</span><button type="button" data-act="sign-out">Sign out</button></p></div>`;
      // The team's own logo, from the saved standings
      if (league) {
        fetch(`${DATA}standings.json`).then((r) => r.json()).then((st) => {
          const t = ((st.leagues[league.slug] || {}).teams || []).find((x) => x.id === me.team_id);
          const img = document.getElementById('acct-logo');
          const src = customLogo({ id: me.team_id }, league) || (t && t.logo);
          if (src && img) img.src = src;
        }).catch(() => {});
      }
    }
    el.insertAdjacentHTML('beforeend', '<section class="panel acct-card app-card" id="app-panel" aria-label="App and notifications"></section>');
    drawAppPanel();
  }

  // ---------- the app (installable site) and notifications ----------
  // sw.js shows notifications and keeps the last pages seen for offline use; manifest.webmanifest makes the
  // site installable. Notifications come from the push Edge Function (supabase/functions/push).
  let installPrompt = null; // Chrome/Android's install offer, kept for the Install button
  let deviceSaved = false; // this visit re-saved the device's subscription (its address can change)
  const appStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // Pull down to refresh, in the installed app only (a browser tab has its own). Starts only at the top of the
  // page, outside text boxes and scrolled panels, and gives way to sideways swipes.
  if (appStandalone() && 'ontouchstart' in window) {
    const READY = 70;
    const ptr = document.createElement('div');
    ptr.className = 'ptr';
    ptr.setAttribute('aria-hidden', 'true');
    ptr.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    document.body.appendChild(ptr);
    let start = null, dist = 0;
    const draw = () => {
      ptr.style.transform = `translate(-50%, ${dist - 50}px)`;
      ptr.style.opacity = Math.min(dist / READY, 1);
      ptr.firstChild.style.transform = `rotate(${dist * 3}deg)`;
      ptr.classList.toggle('ready', dist >= READY);
    };
    const inScrolled = (el) => { for (; el && el !== document.body; el = el.parentElement) if (el.scrollTop > 0) return true; return false; };
    window.addEventListener('touchstart', (e) => {
      dist = 0;
      const t = e.target;
      start = e.touches.length === 1 && window.scrollY <= 0 && !inScrolled(t)
        && !(t.closest && t.closest('input, textarea, select, [contenteditable], dialog'))
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x, dy = e.touches[0].clientY - start.y;
      if (!dist && (Math.abs(dx) > Math.abs(dy) || dy < 0)) { if (Math.abs(dx) > 8 || dy < -8) start = null; return; }
      dist = Math.max(0, Math.min(dy * 0.5, 110));
      if (e.cancelable) e.preventDefault();
      draw();
    }, { passive: false });
    const release = () => {
      if (!start) return;
      start = null;
      if (dist >= READY) {
        ptr.classList.add('spin');
        dist = READY;
        draw();
        location.reload();
        return;
      }
      ptr.classList.add('back');
      dist = 0;
      draw();
      setTimeout(() => ptr.classList.remove('back'), 200);
    };
    window.addEventListener('touchend', release);
    window.addEventListener('touchcancel', release);
  }
  const appIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((err) => console.warn('No offline app', err)));
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'open') location.href = e.data.url; });
  }
  window.addEventListener('beforeinstallprompt', (e) => { installPrompt = e; drawAppPanel(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; drawAppPanel(); });

  function notifyPost(id) {
    if (!id || !ACCOUNT || !ACCOUNT.push) return;
    ACCOUNT.push({ action: 'post', id }).catch((err) => console.warn('Notifications not sent', err.message));
  }
  const keyBytes = (b64) => {
    const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  async function deviceSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  const saveDevice = (sub) => {
    const j = sub.toJSON();
    return ACCOUNT.write('save_push_device', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  };

  async function drawAppPanel(note) {
    const el = document.getElementById('app-panel');
    if (!el) return;
    const s = ACCOUNT ? ACCOUNT.state : {};
    const member = Boolean(s.me && s.me.league);
    const ios = appIos();
    const installed = appStandalone();
    const install = installed ? '<p class="acct-lede">You’re using the MGDX app.</p>'
      : installPrompt ? `<p class="acct-lede">Add MGDX to your home screen. It opens full screen, like any other app.</p>
          <button class="btn" type="button" data-app="install">Install the app</button>`
      : ios ? `<p class="acct-lede">Add MGDX to your Home Screen. It opens full screen, like any other app.</p>
          <ol class="app-steps"><li>Open mgdxfantasy.com in <b>Safari</b>.</li><li>Tap the <b>Share</b> button <span class="app-share" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>`
      : `<p class="acct-lede">Add MGDX to your home screen: open your browser’s menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>`;

    let notes = '';
    if (member) {
      const sub = await deviceSubscription().catch(() => null);
      if (!document.getElementById('app-panel')) return;
      if (sub && !deviceSaved) { deviceSaved = true; saveDevice(sub).catch(() => {}); }
      let settings = null;
      try { [settings] = await ACCOUNT.write('push_settings'); } catch (err) { console.warn(err); }
      if (!document.getElementById('app-panel')) return;
      const toggles = settings ? `
        <fieldset class="app-prefs"${sub ? '' : ' disabled'}>
          <legend class="sr-only">Send me a notification</legend>
          ${[['posts', 'Every new post on the Main Blog'], ['mentions', 'When someone @mentions me'], ['replies', 'When someone replies to my post'],
            ['recaps', 'When the weekly recap is up'], ['picks', 'An hour before Predictions lock'],
       ['results', 'My final results each week (Tuesday 9 AM)'], ['race', 'Playoff race news (clinched, out, on the bubble)'],
       ['records', 'When a result makes an all-time top 10']]
            .map(([k, label]) => `<label class="app-pref"><input type="checkbox" data-pref="${k}" ${settings[k] ? 'checked' : ''}><span>${label}</span></label>`).join('')}
        </fieldset>` : '';
      let state;
      if (!pushSupported()) {
        state = ios && !installed
          ? '<p class="acct-lede">On iPhone and iPad, notifications work in the app. Add it to your Home Screen (above), open MGDX from there, and turn them on here.</p>'
          : '<p class="acct-lede">This browser can’t show notifications. Try the app on your phone.</p>';
      } else if (Notification.permission === 'denied') {
        state = '<p class="acct-lede">Notifications are blocked for MGDX. Allow them in your phone or browser settings, then come back here.</p>';
      } else if (sub) {
        state = `<p class="acct-lede"><b class="app-on">On</b> for this device.</p>
          <div class="app-actions"><button class="btn" type="button" data-app="test">Send a test</button>
          <button class="btn-quiet" type="button" data-app="off">Turn off on this device</button></div>`;
      } else {
        state = `<p class="acct-lede">Get a notification for new posts, @mentions and replies, the weekly recap, and a reminder before Predictions lock.</p>
          <button class="btn" type="button" data-app="on">Turn on notifications</button>`;
      }
      notes = `<h3>Notifications</h3>${state}${toggles}`;
    }
    el.innerHTML = `<h2>The MGDX app</h2>${install}${notes}<p class="acct-msg app-msg" role="status">${note ? esc(note) : ''}</p>`;
  }
  const appMessage = (text, error) => {
    const p = document.querySelector('#app-panel .app-msg');
    if (!p) return;
    p.textContent = text;
    p.classList.toggle('error', Boolean(error));
  };

  if (ACCOUNT && !ARCHIVE) {
    main.addEventListener('click', async (e) => {
      const b = e.target.closest('#app-panel button[data-app]');
      if (!b) return;
      const act = b.dataset.app;
      b.disabled = true;
      try {
        if (act === 'install' && installPrompt) {
          installPrompt.prompt();
          await installPrompt.userChoice;
          installPrompt = null;
          drawAppPanel();
        } else if (act === 'on') {
          const perm = await Notification.requestPermission(); // first, while the tap still counts
          if (perm !== 'granted') { drawAppPanel(perm === 'denied' ? '' : 'Notifications weren’t turned on.'); return; }
          const reg = await navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready);
          const { publicKey } = await ACCOUNT.push({ action: 'key' });
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
          await saveDevice(sub);
          deviceSaved = true;
          drawAppPanel('Notifications are on. Try Send a test.');
        } else if (act === 'off') {
          const sub = await deviceSubscription();
          if (sub) {
            await ACCOUNT.write('remove_push_device', { p_endpoint: sub.endpoint }).catch(() => {});
            await sub.unsubscribe();
          }
          drawAppPanel('Notifications are off for this device.');
        } else if (act === 'test') {
          const { sent } = await ACCOUNT.push({ action: 'test' });
          appMessage(sent ? `Sent to ${sent} device${sent === 1 ? '' : 's'}. It should arrive in a few seconds.` : 'No devices got it. Turn notifications off and on again.', !sent);
          b.disabled = false;
        }
      } catch (err) {
        b.disabled = false;
        appMessage(err.message || String(err), true);
      }
    });
    main.addEventListener('change', async (e) => {
      const box = e.target.closest('#app-panel input[data-pref]');
      if (!box) return;
      const args = { [`p_${box.dataset.pref}`]: box.checked }; // the others stay as they are
      try {
        await ACCOUNT.write('set_push_settings', args);
        appMessage('Saved.');
      } catch (err) {
        box.checked = !box.checked;
        appMessage(err.message || String(err), true);
      }
    });
  }

  function accountMessage(text, error) {
    const p = document.querySelector('#account-body .acct-msg');
    if (!p) return;
    p.textContent = text;
    p.classList.toggle('error', Boolean(error));
  }

  if (ACCOUNT && !ARCHIVE) {
    ACCOUNT.onChange(() => { if (parseHash().parts[0] === 'account') drawAccount(); });
    main.addEventListener('click', async (e) => {
      const b = e.target.closest('#account-body button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      try {
        if (act === 'mode') { accountMode = accountMode === 'sign-up' ? 'sign-in' : 'sign-up'; drawAccount(); }
        else if (act === 'google') { b.disabled = true; await ACCOUNT.google(); }
        else if (act === 'sign-out') {
          const sub = await deviceSubscription().catch(() => null);
          if (sub) {
            await ACCOUNT.write('remove_push_device', { p_endpoint: sub.endpoint }).catch(() => {});
            await sub.unsubscribe().catch(() => {});
          }
          await ACCOUNT.signOut();
        }
        else if (act === 'use-link') { b.disabled = true; await ACCOUNT.useEmailLink(); }
        else if (act === 'resend') {
          const email = document.querySelector('#account-body input[name=email]').value.trim();
          if (!email) return accountMessage('Enter your email above, then choose Resend the confirmation email again.', true);
          await ACCOUNT.resendConfirmation(email);
          accountMessage(`If ${email} has an account waiting to be confirmed, a new confirmation link is on its way.`);
        }
        else if (act === 'forgot') {
          const email = document.querySelector('#account-body input[name=email]').value.trim();
          if (!email) return accountMessage('Enter your email above, then choose Forgot your password again.', true);
          await ACCOUNT.resetPassword(email);
          accountMessage(`If ${email} has an account, a link to reset the password is on its way.`);
        }
      } catch (err) {
        b.disabled = false;
        accountMessage(err.message || String(err), true);
      }
    });
    main.addEventListener('submit', async (e) => {
      const form = e.target.closest('#account-body form[data-act]');
      if (!form) return;
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const act = form.dataset.act;
        if (act === 'sign-in') await ACCOUNT.signIn(f.email.trim(), f.password);
        else if (act === 'sign-up') {
          if (await ACCOUNT.signUp(f.email.trim(), f.password)) accountMessage(`Check ${f.email.trim()} for a link to confirm your account, then sign in.`);
        } else if (act === 'new-password') await ACCOUNT.updatePassword(f.password);
        else if (act === 'claim') {
          const err = await ACCOUNT.claim(f.code);
          if (err) accountMessage(CLAIM_ERRORS[err] || 'Something went wrong. Try again.', true);
        }
      } catch (err) {
        accountMessage(err.message || String(err), true);
      }
      btn.disabled = false;
    });
  }

  // ---------- archives ----------
  const ARCHIVE_TABS = ['records', 'career', 'rivalries', 'history'];
  const ARCHIVE_TAB_NAMES = { records: 'Records', career: 'Careers', rivalries: 'Rivalries', history: 'League History' };
  const ARCHIVE_KICKERS = { records: 'All-time bests and worsts', career: 'Every manager, all seasons', rivalries: 'Head to head', history: 'Champions and seasons past' };

  // sub 'manager' is a manager's page, under the Careers tab.
  function renderArchives(sub, params) {
    const p = PLACEHOLDERS.archives;
    const tab = sub === 'manager' ? 'career' : sub;
    document.body.dataset.theme = 'home';
    document.title = `${ARCHIVE_TAB_NAMES[tab]} · Archives · Microgen Fantasy Football`;
    main.innerHTML = `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-seal.png?v=2" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow">${esc(p.kicker)}</p>
          <h1 class="page-title">${esc(p.title)}</h1>
        </div>
      </section>
      <nav class="subtabs four" aria-label="Archives sections">
        ${ARCHIVE_TABS.map((s) => `<a href="#/archives/${s}" class="${s === tab ? 'active' : ''}" ${s === sub ? 'aria-current="page"' : ''}>${ARCHIVE_TAB_NAMES[s]}</a>`).join('')}
      </nav>
      <div id="league-body">${loading(sub === 'history' ? 'Loading league history' : sub === 'manager' ? 'Loading manager' : sub === 'career' ? 'Loading careers' : sub === 'rivalries' ? 'Loading rivalries' : 'Loading records')}</div>`;
    if (sub === 'history') renderHistory(params);
    else if (sub === 'manager') renderManager(params);
    else if (sub === 'career') renderCareer();
    else if (sub === 'rivalries') renderRivalries(params);
    else renderRecords();
  }

  // ---------- careers ----------
  // One row per manager (by the name the league uses), across every season. Finished seasons' records come from
  // data/history.json, as League History shows them; this season's from data/standings.json, as Standings shows it.
  // Playoff games, streaks and points per game come from the saved games (games.json, playoffs.json).
  let careerData = null;
  function loadCareerData() {
    if (!careerData) careerData = buildCareerData().catch((err) => { careerData = null; throw err; });
    return careerData;
  }
  async function buildCareerData() {
    const json = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const past = SEASON_PAGES.filter((y) => y !== SEASON);
    const [history, current, mine, ...files] = await Promise.all([
      json('data/history.json'), json('data/standings.json'), json('data/games.json'),
      ...past.flatMap((y) => [json('data/seasons/' + y + '/games.json'), json('data/seasons/' + y + '/playoffs.json'), json('data/seasons/' + y + '/standings.json')]),
    ]);
    if (!history || !current) throw new Error('Couldn’t load the saved seasons');
    const people = new Map();
    const person = (owner) => {
      if (!people.has(owner)) {
        people.set(owner, { owner, seasons: 0, w: 0, l: 0, t: 0, inW: 0, inL: 0, inT: 0, xW: 0, xL: 0, xT: 0, pw: 0, pl: 0,
          winRun: 0, lossRun: 0, pts: 0, weeks: 0, grand: 0, losses: 0, titles: [], last: null,
          list: [], scores: [] });
      }
      return people.get(owner);
    };
    const leagueOf = (slug) => LEAGUES.find((l) => l.slug === slug);
    const add = (p, x) => {
      p.seasons++;
      for (const k of ['w', 'l', 't', 'inW', 'inL', 'inT', 'xW', 'xL', 'xT']) p[k] += x[k] || 0;
    };

    // Finished seasons, oldest first, so a manager's latest team ends up as "last".
    const byYear = new Map(past.map((y, i) => [y, { games: files[i * 3], playoffs: files[i * 3 + 1], standings: files[i * 3 + 2] }]));
    const years = Object.keys(history.seasons).map(Number).filter((y) => y !== SEASON).sort((a, b) => a - b);
    for (const y of years) {
      const season = history.seasons[y];
      const saved = byYear.get(y) || {};
      const logos = new Map();
      for (const [slug, l] of Object.entries((saved.standings && saved.standings.leagues) || {})) for (const t of l.teams) logos.set(slug + ':' + t.owner, t.logo);
      const cut = saved.standings ? Object.values(saved.standings.leagues)[0].playoffTeams : 4;
      for (const t of season.teams) {
        const p = person(t.owner);
        add(p, t);
        if (season.grandChampion === t.owner) p.grand++;
        if (season.ultimateLoser === t.owner) p.losses++;
        if (season.champions[t.league] === t.owner) p.titles.push(t.league);
        p.last = { year: y, team: t.team, league: leagueOf(t.league), logo: logos.get(t.league + ':' + t.owner) };
        p.list.push({ ...p.last, w: t.w, l: t.l, t: t.t || 0, inW: t.inW, inL: t.inL, inT: t.inT || 0, xW: t.xW, xL: t.xL, xT: t.xT || 0,
          pf: t.pf, pa: t.pa, seed: t.seed, finish: t.finish, final: t.final, of: season.teams.length,
          grand: season.grandChampion === t.owner, loser: season.ultimateLoser === t.owner, champ: season.champions[t.league] === t.owner,
          link: SEASON_PAGES.includes(y) ? y + '.html#/home/final-standings' : '#/archives/history?year=' + y });
      }
      // Playoff record: every playoffs-bracket game a playoff team played; the top score of the game wins it.
      const seeds = new Map(season.teams.map((t) => [t.owner, t.seed]));
      ((saved.playoffs && saved.playoffs.games) || []).forEach((g, j) => {
        for (const x of g.teams) {
          const team = (season.teams.find((t) => t.owner === x.owner) || {}).team;
          person(x.owner).scores.push({ year: y, week: g.week, pf: x.score, team, label: g.bracket === 'toilet' ? 'Toilet Bowl' : 'Playoffs', link: SEASON_PAGES.includes(y) ? y + '.html' + playoffGameLink(g, j) : '' });
        }
      });
      for (const g of (saved.playoffs && saved.playoffs.games) || []) {
        if (g.bracket !== 'playoffs') continue;
        const best = Math.max(...g.teams.map((x) => x.score));
        for (const x of g.teams) {
          if (!(seeds.get(x.owner) <= cut)) continue;
          if (x.score === best) person(x.owner).pw++;
          else person(x.owner).pl++;
        }
      }
    }
    // This season so far, as Standings has it.
    for (const [slug, l] of Object.entries(current.leagues)) {
      l.teams.forEach((t, i) => {
        const p = person(t.owner);
        add(p, { w: t.wins, l: t.losses, t: t.ties, inW: t.inW, inL: t.inL, inT: t.inT, xW: t.xW, xL: t.xL, xT: t.xT });
        p.last = { year: SEASON, team: t.name, league: leagueOf(slug), logo: t.logo, current: true, id: t.id };
        p.list.push({ ...p.last, w: t.wins, l: t.losses, t: t.ties || 0, inW: t.inW, inL: t.inL, inT: t.inT || 0, xW: t.xW, xL: t.xL, xT: t.xT || 0,
          pf: t.pf, pa: t.pa, rank: i + 1, of: l.teams.length, week: current.week, link: '#/' + slug + '/standings' });
      });
    }
    // Streaks (longest within one season) and points per game, from every season's saved games.
    const gameFiles = past.map((y) => [y, byYear.get(y).games]).concat([[SEASON, mine]]).filter(([y, g]) => g && g.season === y);
    for (const [year, file] of gameFiles) {
      const weeks = teamWeeks(file);
      // Each week's score once, linked to that week's in-league game (or its first game, on a bye)
      const links = new Map();
      for (const [week, a, , b, , hash] of file.games) {
        for (const key of [a, b]) {
          const id = key + '|' + week;
          if (key !== 'median' && (!links.has(id) || hash.includes('/matchups'))) links.set(id, hash);
        }
      }
      const at = (hash) => (year === SEASON ? hash : year + '.html' + hash);
      for (const w of weeks) {
        const p = person(file.teams[w.key][1]);
        p.pts += w.pf;
        p.weeks++;
        const row = p.list.find((x) => x.year === year);
        if (row) { row.pts = (row.pts || 0) + w.pf; row.weeks = (row.weeks || 0) + 1; }
        p.scores.push({ year, week: w.week, pf: w.pf, team: file.teams[w.key][0], label: 'Regular season', link: at(links.get(w.key + '|' + w.week) || '') });
      }
      for (const r of seasonRuns(weeks, Infinity)) {
        const p = person(file.teams[r.key][1]);
        if (r.result === 'W') p.winRun = Math.max(p.winRun, r.n);
        else p.lossRun = Math.max(p.lossRun, r.n);
      }
    }
    return { people, years, history };
  }

  async function renderCareer() {
    const token = renderToken;
    const body = () => document.getElementById('league-body');
    let data;
    try { data = await loadCareerData(); } catch (err) { console.error(err); data = null; }
    if (token !== renderToken) return;
    if (!data) {
      body().innerHTML = '<div class="state state-error" role="alert"><strong>Couldn\'t load careers.</strong><a class="btn" href="#/archives/career" onclick="window.dispatchEvent(new HashChangeEvent(\'hashchange\'));return false;">Try again</a></div>';
      return;
    }
    const { people, years, history } = data;
    const list = [...people.values()].filter((p) => p.last);
    const pct = (w, l, t) => (w + l + t ? (w + t / 2) / (w + l + t) : 0);
    const val = {
      seasons: (p) => p.seasons,
      pct: (p) => pct(p.w, p.l, p.t),
      league: (p) => pct(p.inW, p.inL, p.inT),
      cross: (p) => pct(p.xW, p.xL, p.xT),
      playoffs: (p) => (p.pw + p.pl ? p.pw / (p.pw + p.pl) + p.pw / 1000 : -1),
      win: (p) => p.winRun,
      loss: (p) => p.lossRun,
      ppg: (p) => (p.weeks ? p.pts / p.weeks : 0),
    };
    const rec = (w, l, t) => w + '-' + l + (t ? '-' + t : '');
    const badges = (p) => champBadges({ grandTitles: p.grand, ultimateLosses: p.losses, titles: p.titles });
    const row = (p) => {
      const lg = p.last.league;
      return '<tr class="lg-row" style="--lc:var(--' + lg.theme + ')">'
        + '<td class="c-team"><a class="team-cell" href="' + managerHref(p.owner) + '">' + teamLogo({ logo: p.last.logo }, lg)
        + '<span><strong>' + esc(p.owner) + '</strong><small>' + esc(p.last.team) + badges(p) + '</small>'
        + '<small class="lg-name">' + (p.last.current ? esc(lg.name) : 'Last played ' + p.last.year) + '</small></span></a></td>'
        + '<td class="c-num hide-sm">' + p.seasons + '</td>'
        + '<td class="c-num c-ppg">' + (p.weeks ? f2(p.pts / p.weeks) : '—') + '</td>'
        + '<td class="c-num c-rec">' + rec(p.w, p.l, p.t) + '</td>'
        + '<td class="c-num hide-sm">' + pct(p.w, p.l, p.t).toFixed(3).replace(/^0/, '') + '</td>'
        + '<td class="c-num hide-sm muted">' + rec(p.inW, p.inL, p.inT) + '</td>'
        + '<td class="c-num hide-sm muted">' + rec(p.xW, p.xL, p.xT) + '</td>'
        + '<td class="c-num hide-sm">' + (p.pw + p.pl ? rec(p.pw, p.pl) : '<span class="muted">—</span>') + '</td>'
        + '<td class="c-num hide-sm">' + (p.winRun ? 'W' + p.winRun : '—') + '</td>'
        + '<td class="c-num hide-sm">' + (p.lossRun ? 'L' + p.lossRun : '—') + '</td>'
        + '</tr>';
    };
    let sort = { key: 'ppg', dir: 'desc' };
    const table = () => {
      const v = val[sort.key];
      const sorted = list.slice().sort((a, b) => (sort.dir === 'desc' ? v(b) - v(a) : v(a) - v(b)) || val.pct(b) - val.pct(a) || b.w - a.w);
      return '<table class="standings career-table"><thead><tr>'
        + '<th>Manager</th>'
        + sortHeader(sort, 'seasons', 'Seasons', 'c-num hide-sm', 'Sort by seasons played')
        + sortHeader(sort, 'ppg', 'PPG', 'c-num', 'Sort by average points per game')
        + sortHeader(sort, 'pct', 'Overall', 'c-num', 'Sort by overall win percentage')
        + '<th class="c-num hide-sm">Pct</th>'
        + sortHeader(sort, 'league', 'League', 'c-num hide-sm', 'Sort by in-league win percentage')
        + sortHeader(sort, 'cross', 'Cross', 'c-num hide-sm', 'Sort by cross-league win percentage')
        + sortHeader(sort, 'playoffs', 'Playoffs', 'c-num hide-sm', 'Sort by playoff win percentage')
        + sortHeader(sort, 'win', 'Win streak', 'c-num hide-sm', 'Sort by longest winning streak')
        + sortHeader(sort, 'loss', 'Loss streak', 'c-num hide-sm', 'Sort by longest losing streak')
        + '</tr></thead><tbody>' + sorted.map(row).join('') + '</tbody></table>';
    };
    body().innerHTML = '<p class="pw-status">All ' + list.length + ' managers since ' + years.concat(SEASON)[0] + ', including ' + SEASON + ' so far.</p>'
      + '<p class="mg-note">Tap a manager to open their page: every season, best and worst weeks, and their record against everyone they’ve played.</p>'
      + '<p class="pw-sort">Table sortable by Seasons, PPG, Overall, League, Cross, Playoffs and streaks</p>'
      + '<div class="panel st-panel ' + (standingsExpanded ? 'st-expanded' : '') + '">'
      + '<button class="toggle st-expand" type="button" aria-expanded="' + standingsExpanded + '">' + (standingsExpanded ? 'Show fewer columns' : 'Show all columns') + '</button>'
      + '<p class="st-hint">Swipe the table sideways to see every column</p>'
      + '<div class="table-wrap">' + table() + '</div></div>'
      + '<p class="fineprint">Managers are matched across seasons by the name the league uses. Records are regular season: finished seasons as League History shows them, ' + SEASON + ' as Standings shows it; ' + (history.seasons[2023] ? 'Cross includes 2023’s bye-week games against the median. ' : '') + 'Playoffs counts every playoff-bracket game a playoff team played, Weeks 15 to 17, including placement finals; the top score of the game wins it, so a three- or four-team game is one win for the top score and one loss for each other team. Streaks are the longest within one season (in-league game before cross-league each week; a tie ends one). PPG is the average weekly score in the regular season, from ESPN. The logo and team name are each manager’s most recent.</p>';
    const wrap = body().querySelector('.table-wrap');
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('th button[data-sort]');
      if (!btn) return;
      const key = btn.dataset.sort;
      sort = key === sort.key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
      wrap.innerHTML = table();
      wrap.querySelector('th button[data-sort="' + key + '"]').focus();
    });
  }

  // ---------- manager pages ----------
  // One manager's whole history: #/archives/manager?name=Bryce. Built from the same data as Careers (records,
  // titles, weekly scores) and Rivalries (every head-to-head game).
  const managerHref = (name) => `#/archives/manager?name=${encodeURIComponent(name)}`;

  async function renderManager(params) {
    const token = renderToken;
    const body = () => document.getElementById('league-body');
    let data, rivals;
    try { [data, rivals] = await Promise.all([loadCareerData(), loadRivalData()]); } catch (err) { console.error(err); }
    if (token !== renderToken) return;
    if (!data) {
      body().innerHTML = `<div class="state state-error" role="alert"><strong>Couldn't load this manager.</strong><a class="btn" href="${managerHref(params.get('name') || '')}" onclick="window.dispatchEvent(new HashChangeEvent('hashchange'));return false;">Try again</a></div>`;
      return;
    }
    const all = [...data.people.values()].filter((x) => x.last);
    const names = all.map((x) => x.owner).sort((a, b) => a.localeCompare(b));
    const name = params.get('name');
    const p = data.people.get(name);
    const picker = `<label class="select mg-pick"><span class="sr-only">Choose a manager</span><select id="mg-select">
      ${p ? '' : '<option value="" selected>Choose a manager</option>'}${names.map((n) => `<option value="${esc(n)}" ${n === name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
    const bind = () => body().querySelector('#mg-select').addEventListener('change', (e) => { if (e.target.value) location.hash = managerHref(e.target.value); });
    if (!p || !p.last) {
      body().innerHTML = `<div class="mg-bar"><a class="mg-back" href="#/archives/career">‹ All managers</a>${picker}</div>
        <div class="state"><strong>${name ? `No manager named “${esc(name)}”.` : 'Pick a manager.'}</strong></div>`;
      bind();
      return;
    }
    document.title = `${p.owner} · Archives · Microgen Fantasy Football`;
    const lg = p.last.league;
    const rec = (w, l, t) => `${w}-${l}${t ? `-${t}` : ''}`;
    const pctOf = (w, l, t) => (w + l + t ? (w + t / 2) / (w + l + t) : 0);
    const pct3 = (x) => x.toFixed(3).replace(/^0/, '');
    const seasons = p.list.slice().sort((a, b) => b.year - a.year);
    const done = seasons.filter((x) => !x.current);
    const first = Math.min(...seasons.map((x) => x.year));

    // ----- headline numbers -----
    const best = done.length ? done.reduce((a, b) => (b.finish < a.finish ? b : a)) : null;
    const titleCount = p.titles.length;
    const tiles = [
      ['Seasons', p.seasons, `Since ${first}`],
      ['Overall record', rec(p.w, p.l, p.t), `${pct3(pctOf(p.w, p.l, p.t))} win rate`],
      ['Points per game', p.weeks ? f2(p.pts / p.weeks) : '—', 'Regular season'],
      ['Playoffs', p.pw + p.pl ? rec(p.pw, p.pl) : '—', p.pw + p.pl ? 'Playoff-bracket games' : 'No playoff games yet'],
      ['League titles', titleCount, [p.grand ? `${p.grand} grand championship${p.grand > 1 ? 's' : ''}` : '', p.losses ? `${p.losses} Ultimate Loser` : ''].filter(Boolean).join(' · ') || (titleCount ? 'League champion' : 'Not yet')],
      ['Best finish', best ? ordinal(best.finish) : '—', best ? `of ${best.of}, ${best.year}` : 'First season in progress'],
      ['Longest win streak', p.winRun ? `W${p.winRun}` : '—', 'Within a season'],
      ['Longest losing streak', p.lossRun ? `L${p.lossRun}` : '—', 'Within a season'],
    ];

    // ----- season by season -----
    const finishText = (x) => {
      if (x.current) return `<b>${ordinal(x.rank)}</b><small>in ${esc(x.league.name)} · through Week ${x.week - 1}</small>`;
      const honors = [x.grand ? 'Grand champion' : '', x.champ && !x.grand ? `${esc(x.league.name)} champion` : '', x.loser ? 'Ultimate loser' : ''].filter(Boolean);
      const final = x.final ? `${x.final.won ? 'Won' : 'Lost'} ${esc(x.final.label)}` : '';
      return `<b>${ordinal(x.finish)}</b><small>${honors.length ? honors.join(' · ') : final}${x.seed ? ` · ${ordinal(x.seed)} seed` : ''}</small>`;
    };
    const seasonRows = seasons.map((x) => {
      // As Standings and Final Standings show it: this season from ESPN's weekly scores, finished seasons from
      // their official PF over the weeks played (two games a week).
      const ppg = x.current && x.weeks ? x.pts / x.weeks : x.pf / ((x.w + x.l + x.t) / 2 || 1);
      return `
        <tr class="lg-row" style="--lc:var(--${x.league.theme})">
          <td class="c-rank"><a class="mg-year" href="${x.link}">${x.year}</a></td>
          <td class="c-team"><a class="team-cell" href="${x.link}">${teamLogo({ logo: x.current ? customLogo({ id: x.id }, x.league) || x.logo : x.logo }, x.league)}
            <span><strong>${esc(x.team)}</strong><small class="lg-name">${esc(x.league.name)}</small></span></a></td>
          <td class="c-num c-rec">${rec(x.w, x.l, x.t)}</td>
          <td class="c-num hide-sm muted">${rec(x.inW, x.inL, x.inT)}</td>
          <td class="c-num hide-sm muted">${rec(x.xW, x.xL, x.xT)}</td>
          <td class="c-num hide-sm">${f2(x.pf)}</td>
          <td class="c-num">${f2(ppg)}</td>
          <td class="mg-finish">${finishText(x)}</td>
        </tr>`;
    }).join('');

    // ----- best and worst weeks -----
    const scored = p.scores.filter((x) => x.pf > 0);
    const weekList = (list) => list.map((x) => `
      <li><a href="${x.link || '#'}"><b>${f2(x.pf)}</b><span>${x.year} · Week ${x.week}${x.label !== 'Regular season' ? ` · ${esc(x.label)}` : ''}<small>${esc(x.team || '')}</small></span></a></li>`).join('');
    const top = scored.slice().sort((a, b) => b.pf - a.pf).slice(0, 5);
    const bottom = scored.slice().sort((a, b) => a.pf - b.pf).slice(0, 5);

    // ----- head to head -----
    const vs = new Map();
    for (const m of (rivals && rivals.meetings) || []) {
      const me = m.x.owner === p.owner ? m.x : m.y.owner === p.owner ? m.y : null;
      if (!me) continue;
      const them = me === m.x ? m.y : m.x;
      const r = vs.get(them.owner) || vs.set(them.owner, { owner: them.owner, w: 0, l: 0, t: 0, pf: 0, pa: 0 }).get(them.owner);
      r[me.score > them.score ? 'w' : me.score < them.score ? 'l' : 't']++;
      r.pf += me.score;
      r.pa += them.score;
    }
    const opps = [...vs.values()].map((r) => Object.assign(r, { n: r.w + r.l + r.t, pct: pctOf(r.w, r.l, r.t) }));
    const enough = opps.filter((r) => r.n >= 3);
    const fav = enough.slice().sort((a, b) => b.pct - a.pct || b.n - a.n)[0];
    const nem = enough.slice().sort((a, b) => a.pct - b.pct || b.n - a.n)[0];
    const rivalHref = (o) => `#/archives/rivalries?a=${encodeURIComponent(p.owner)}&b=${encodeURIComponent(o)}`;
    const callout = (label, r, cls) => (r ? `
      <a class="mg-callout ${cls}" href="${rivalHref(r.owner)}"><small>${label}</small><strong>${esc(r.owner)}</strong><span>${rec(r.w, r.l, r.t)} in ${r.n} games</span></a>` : '');
    const rivalRow = (r) => `
        <tr>
          <td><a href="${managerHref(r.owner)}">${esc(r.owner)}</a></td>
          <td class="c-num">${r.n}</td>
          <td class="c-num c-rec ${r.w > r.l ? 'mg-up' : r.w < r.l ? 'mg-down' : ''}">${rec(r.w, r.l, r.t)}</td>
          <td class="c-num hide-sm">${f2(r.pf / r.n)}</td>
          <td class="c-num hide-sm muted">${f2(r.pa / r.n)}</td>
          <td class="c-num"><a class="mg-h2h" href="${rivalHref(r.owner)}">Head to head ›</a></td>
        </tr>`;
    const sortedOpps = opps.sort((a, b) => b.n - a.n || b.pct - a.pct || a.owner.localeCompare(b.owner));

    body().innerHTML = `
      <div class="mg-bar"><a class="mg-back" href="#/archives/career">‹ All managers</a>${picker}</div>
      <section class="panel mg-head" style="--lc:var(--${lg.theme})">
        ${teamLogo({ logo: p.last.current ? customLogo({ id: p.last.id }, lg) || p.last.logo : p.last.logo }, lg, 'avatar mg-logo')}
        <div class="mg-who">
          <p class="eyebrow">${p.last.current ? `${esc(lg.name)} · ${SEASON}` : `Last played ${p.last.year}`}</p>
          <h2>${esc(p.owner)}</h2>
          <p class="mg-team">${esc(p.last.team)}${champBadges({ grandTitles: p.grand, ultimateLosses: p.losses, titles: p.titles })}</p>
        </div>
      </section>
      <div class="mg-tiles">${tiles.map(([label, value, sub]) => `<div class="panel mg-tile"><small>${label}</small><b>${value}</b><span>${sub}</span></div>`).join('')}</div>

      <h3 class="section-label">Season by season</h3>
      <div class="panel"><div class="table-wrap"><table class="standings mg-seasons">
        <thead><tr><th class="c-rank">Year</th><th>Team</th><th class="c-num">Overall</th><th class="c-num hide-sm">League</th><th class="c-num hide-sm">Cross</th><th class="c-num hide-sm">PF</th><th class="c-num" title="Points per game: average weekly score">PPG</th><th>Finish</th></tr></thead>
        <tbody>${seasonRows}</tbody>
      </table></div></div>

      <div class="mg-weeks">
        <section class="panel"><h3 class="section-label">Best weeks</h3><ol class="mg-list">${weekList(top)}</ol></section>
        <section class="panel"><h3 class="section-label">Worst weeks</h3><ol class="mg-list">${weekList(bottom)}</ol></section>
      </div>

      <h3 class="section-label">Head to head</h3>
      ${fav || nem ? `<div class="mg-callouts">${callout('Best record against', fav, 'up')}${callout('Toughest opponent', nem, 'down')}</div>` : ''}
      ${sortedOpps.length ? `<div class="panel"><div class="table-wrap"><table class="standings mg-rivals">
        <thead><tr><th>Opponent</th><th class="c-num">Games</th><th class="c-num">Record</th><th class="c-num hide-sm" title="${esc(p.owner)}’s average score against them">Scored</th><th class="c-num hide-sm" title="Their average score against ${esc(p.owner)}">Allowed</th><th class="c-num"><span class="sr-only">Head to head</span></th></tr></thead>
        <tbody>${sortedOpps.slice(0, 10).map(rivalRow).join('')}</tbody>
        ${sortedOpps.length > 10 ? `<tbody class="mg-more" hidden>${sortedOpps.slice(10).map(rivalRow).join('')}</tbody>` : ''}
      </table></div>
      ${sortedOpps.length > 10 ? `<button class="toggle mg-show" type="button" aria-expanded="false">Show all ${sortedOpps.length} opponents</button>` : ''}</div>`
        : '<div class="state"><strong>No head-to-head games yet.</strong></div>'}
      <p class="fineprint">Records are regular season (finished seasons as League History shows them, ${SEASON} as Standings shows it). Finish is the final place after the playoffs, out of every team that season. Best and worst weeks include past seasons’ playoff and Toilet Bowl games. Head to head counts every game against each manager, playoffs included, as Rivalries does; best record and toughest opponent need at least 3 games. Tap a season, week or opponent to see it.</p>`;
    bind();
    const more = body().querySelector('.mg-show');
    if (more) more.addEventListener('click', () => {
      const extra = body().querySelector('.mg-more');
      const open = extra.hidden;
      extra.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      more.textContent = open ? 'Show fewer' : `Show all ${sortedOpps.length} opponents`;
    });
  }

  // ---------- rivalries ----------
  // Every game two managers have played each other, matched by the name the league uses: regular-season games
  // (in-league and cross-league) from each season's games.json, this season's finished weeks included, and past
  // seasons' playoff and Toilet Bowl games from playoffs.json (in a three-team game, the higher of the two scores
  // wins their head to head). Loaded once per visit.
  let rivalData = null;
  async function loadRivalData() {
    if (rivalData) return rivalData;
    const json = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const past = SEASON_PAGES.filter((y) => y !== SEASON);
    const years = [...past, SEASON];
    const dirOf = (y) => (y === SEASON ? 'data/' : `data/seasons/${y}/`);
    const files = await Promise.all(years.flatMap((y) => [json(`${dirOf(y)}games.json`), json(`${dirOf(y)}standings.json`), y === SEASON ? null : json(`${dirOf(y)}playoffs.json`)]));
    const people = new Map(); // owner -> { owner, team, league, logo, year }
    const games = []; // { year, week, kind, label, link, order, sides: [{ owner, team, league, logo, score }] }
    years.forEach((year, i) => {
      const [g, st, po] = files.slice(i * 3, i * 3 + 3);
      if (!g || g.season !== year) return;
      const link = (hash) => (year === SEASON ? hash : `${year}.html${hash}`);
      const logos = new Map();
      for (const [slug, l] of Object.entries((st && st.leagues) || {})) for (const t of l.teams) logos.set(`${slug}:${t.id}`, t.logo);
      const side = (key) => {
        const [team, owner] = g.teams[key];
        const slug = key.split(':')[0];
        return { owner, team, league: LEAGUES.find((l) => l.slug === slug), logo: logos.get(key) };
      };
      for (const key of Object.keys(g.teams)) { const x = side(key); people.set(x.owner, { ...x, year }); } // oldest first, so the latest wins
      for (const [week, a, sa, b, sb, hash] of g.games) {
        if (a === 'median' || b === 'median') continue;
        const inLeague = hash.includes('/matchups');
        games.push({ year, week, kind: inLeague ? 'league' : 'cross', label: inLeague ? 'In-league' : 'Cross-league', link: link(hash),
          order: inLeague ? 0 : 1, sides: [{ ...side(a), score: sa }, { ...side(b), score: sb }] });
      }
      ((po && po.games) || []).forEach((pg, j) => {
        const sides = pg.teams.map((t) => {
          const key = Object.keys(g.teams).find((k) => g.teams[k][1] === t.owner && (!pg.league || k.startsWith(`${pg.league}:`)))
            || Object.keys(g.teams).find((k) => g.teams[k][1] === t.owner);
          return key ? { ...side(key), score: t.score } : null;
        }).filter(Boolean);
        const kind = pg.bracket === 'toilet' ? 'toilet' : 'playoffs';
        games.push({ year, week: pg.week, kind, label: /Toilet Bowl|Playoff/.test(pg.name || pg.title) ? pg.name || pg.title : `${kind === 'toilet' ? 'Toilet Bowl' : 'Playoffs'} · ${pg.name || pg.title}`,
          link: link(playoffGameLink(pg, j)), order: 2, sides });
      });
    });
    // Head-to-head meetings: one per pair of managers in a game.
    const meetings = [];
    for (const g of games) {
      for (let i = 0; i < g.sides.length; i++) {
        for (let j = i + 1; j < g.sides.length; j++) meetings.push({ ...g, x: g.sides[i], y: g.sides[j] });
      }
    }
    meetings.sort((a, b) => a.year - b.year || a.week - b.week || a.order - b.order);
    rivalData = { people, meetings, first: Math.min(...meetings.map((m) => m.year)) };
    return rivalData;
  }

  async function renderRivalries(params) {
    const token = renderToken;
    const body = () => document.getElementById('league-body');
    const data = await loadRivalData().catch((err) => { console.error(err); return null; });
    if (token !== renderToken) return;
    if (!data || !data.meetings.length) {
      body().innerHTML = '<div class="state state-error" role="alert"><strong>Couldn\'t load the rivalries.</strong><a class="btn" href="#/archives/rivalries" onclick="window.dispatchEvent(new HashChangeEvent(\'hashchange\'));return false;">Try again</a></div>';
      return;
    }
    const { people, meetings } = data;
    const names = [...people.keys()].sort((a, b) => a.localeCompare(b));
    const pairKey = (a, b) => [a, b].sort().join('|');
    const counts = new Map();
    for (const m of meetings) { const k = pairKey(m.x.owner, m.y.owner); counts.set(k, (counts.get(k) || 0) + 1); }
    const rivalsOf = (who) => [...counts.entries()].filter(([k]) => k.split('|').includes(who)).sort((a, b) => b[1] - a[1]);

    // Who to show: the link's two managers; otherwise the signed-in member and their most-played opponent;
    // otherwise the most-played rivalry.
    let a = people.has(params.get('a')) ? params.get('a') : null;
    let b = people.has(params.get('b')) ? params.get('b') : null;
    if (!a) {
      const me = ACCOUNT && ACCOUNT.state && ACCOUNT.state.me && ACCOUNT.state.me.name;
      a = me && people.has(me) ? me : [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0].split('|')[0];
    }
    if (!b || b === a) {
      const top = rivalsOf(a)[0];
      b = top ? top[0].split('|').find((n) => n !== a) : names.find((n) => n !== a);
    }

    const games = meetings.filter((m) => (m.x.owner === a && m.y.owner === b) || (m.x.owner === b && m.y.owner === a))
      .map((m) => (m.x.owner === a ? { ...m, me: m.x, them: m.y } : { ...m, me: m.y, them: m.x }));
    const res = (g) => (g.me.score > g.them.score ? 'a' : g.me.score < g.them.score ? 'b' : 't');
    const tally = (list) => list.reduce((r, g) => { r[res(g)]++; return r; }, { a: 0, b: 0, t: 0 });
    const all = tally(games);
    const sum = (list, side) => list.reduce((n, g) => n + g[side].score, 0);
    const wins = (side) => games.filter((g) => res(g) === (side === 'me' ? 'a' : 'b'))
      .map((g) => ({ g, margin: Math.abs(g.me.score - g.them.score) })).sort((x, y) => y.margin - x.margin)[0];
    const high = (side) => games.slice().sort((x, y) => y[side].score - x[side].score)[0];

    const person = (n) => people.get(n);
    const pa = person(a);
    const pb = person(b);
    const options = (sel) => names.map((n) => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const side = (p, wins, cls) => `
      <div class="rv-side ${cls}" style="--lc:var(--${p.league.theme})">
        ${teamLogo({ logo: p.logo }, p.league, 'avatar lg')}
        <div class="rv-who"><strong>${esc(p.owner)}</strong><small>${esc(p.team)}</small><small class="lg-name">${p.year === SEASON ? esc(p.league.name) : `Last played ${p.year}`}</small></div>
        <b class="rv-wins">${wins}</b>
      </div>`;

    const recText = (r, who) => `${who === 'a' ? r.a : r.b}`;
    const kinds = [
      ['In-league wins', games.filter((g) => g.kind === 'league')],
      ['Cross-league wins', games.filter((g) => g.kind === 'cross')],
      ['Playoff wins', games.filter((g) => g.kind === 'playoffs')],
      ['Toilet Bowl wins', games.filter((g) => g.kind === 'toilet')],
    ].filter(([, list]) => list.length);
    const compare = [];
    for (const [label, list] of kinds) { const r = tally(list); compare.push([label, recText(r, 'a'), recText(r, 'b'), r.a - r.b, r.t ? `${r.t} tie${r.t > 1 ? 's' : ''}` : '']); }
    if (games.length) {
      const avgA = sum(games, 'me') / games.length;
      const avgB = sum(games, 'them') / games.length;
      compare.push(['Points per game', f2(avgA), f2(avgB), avgA - avgB]);
      compare.push(['Total points', f2(sum(games, 'me')), f2(sum(games, 'them')), sum(games, 'me') - sum(games, 'them')]);
      const hA = high('me');
      const hB = high('them');
      compare.push(['Highest score', f2(hA.me.score), f2(hB.them.score), hA.me.score - hB.them.score]);
      const wA = wins('me');
      const wB = wins('them');
      compare.push(['Biggest win', wA ? `+${f2(wA.margin)}` : '—', wB ? `+${f2(wB.margin)}` : '—', (wA ? wA.margin : 0) - (wB ? wB.margin : 0)]);
    }
    // The current streak, from the latest game back.
    let streak = '';
    if (games.length) {
      const last = res(games[games.length - 1]);
      let n = 0;
      for (let i = games.length - 1; i >= 0 && res(games[i]) === last; i--) n++;
      streak = last === 't' ? 'Their last game was a tie.'
        : `${esc(last === 'a' ? a : b)} has won ${n === 1 ? 'the last game' : `${n} straight`}.`;
    }
    const lastGame = games[games.length - 1];
    const when = (g) => `${g.year} · Wk ${g.week}`;
    const rows = games.slice().reverse().map((g) => {
      const r = res(g);
      return `
        <tr class="rv-${r}">
          <td class="c-when"><a href="${g.link}">${when(g)}</a><small>${esc(g.label)}</small></td>
          <td class="rv-team ${r === 'a' ? 'won' : ''}"><span>${esc(g.me.team)}</span></td>
          <td class="c-num rv-score ${r === 'a' ? 'won' : ''}">${f2(g.me.score)}</td>
          <td class="c-num rv-score ${r === 'b' ? 'won' : ''}">${f2(g.them.score)}</td>
          <td class="rv-team right ${r === 'b' ? 'won' : ''}"><span>${esc(g.them.team)}</span></td>
        </tr>`;
    }).join('');
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 8);
    const href = (x, y) => `#/archives/rivalries?a=${encodeURIComponent(x)}&b=${encodeURIComponent(y)}`;

    body().innerHTML = `
      <div class="panel rv-pick">
        <label class="select"><span class="sr-only">First manager</span><select id="rv-a">${options(a)}</select></label>
        <button type="button" class="rv-swap" id="rv-swap" title="Swap sides" aria-label="Swap sides"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 7h12m0 0-4-4m4 4-4 4M17 17H5m0 0 4-4m-4 4 4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <label class="select"><span class="sr-only">Second manager</span><select id="rv-b">${options(b)}</select></label>
      </div>
      ${a === b ? '<div class="state"><strong>Pick two different managers.</strong></div>' : `
      <section class="panel rv-head">
        ${side(pa, all.a, all.a > all.b ? 'lead' : '')}
        <div class="rv-mid"><span>vs</span><small>${games.length} game${games.length === 1 ? '' : 's'}${all.t ? ` · ${all.t} tie${all.t > 1 ? 's' : ''}` : ''}</small></div>
        ${side(pb, all.b, `right${all.b > all.a ? ' lead' : ''}`)}
        ${games.length ? `<div class="rv-bar" role="img" aria-label="${esc(a)} ${all.a} wins, ${esc(b)} ${all.b} wins"><i style="flex:${all.a + all.t / 2 || 0.0001};--lc:var(--${pa.league.theme})"></i><i style="flex:${all.b + all.t / 2 || 0.0001};--lc:var(--${pb.league.theme})"></i></div>` : ''}
      </section>
      ${games.length ? `
      <p class="rv-streak">${streak} Last played ${when(lastGame)} (${esc(lastGame.label.toLowerCase())}): <a href="${lastGame.link}">${esc(res(lastGame) === 'b' ? b : a)} ${f2(Math.max(lastGame.me.score, lastGame.them.score))}–${f2(Math.min(lastGame.me.score, lastGame.them.score))}</a>.</p>
      <div class="panel rv-compare">
        ${compare.map(([label, x, y, diff, note]) => `
          <div class="rv-row"><span class="${diff > 0 ? 'won' : ''}">${x}</span><small>${label}${note ? ` <em>· ${note}</em>` : ''}</small><span class="${diff < 0 ? 'won' : ''}">${y}</span></div>`).join('')}
      </div>
      <h3 class="section-label rv-label">Every game</h3>
      <div class="panel"><div class="table-wrap"><table class="standings rv-games">
        <thead><tr><th class="c-when">When</th><th class="rv-team"><span class="sr-only">${esc(a)}’s team</span></th><th class="c-num">${esc(a)}</th><th class="c-num">${esc(b)}</th><th class="rv-team"><span class="sr-only">${esc(b)}’s team</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>` : `<div class="state"><strong>${esc(a)} and ${esc(b)} haven't played each other yet.</strong><span>Since ${data.first}, as far back as the saved games go.</span></div>`}`}
      <h3 class="section-label rv-label">Most-played rivalries</h3>
      <div class="rv-top">${top.map(([k, n]) => { const [x, y] = k.split('|'); return `<a class="rv-chip" href="${href(x, y)}">${esc(x)} <span>vs</span> ${esc(y)} <small>${n}</small></a>`; }).join('')}</div>
      <p class="fineprint">Every game the two managers played against each other since ${data.first}, matched by the name the league uses: regular-season games, in-league and cross-league (${SEASON}'s finished weeks included), plus past seasons' playoff and Toilet Bowl games. In a three-team playoff game, the higher of the two scores wins their head to head. ${data.first <= 2023 ? '2023’s bye-week games against the median don’t count. ' : ''}Tap a game to see it.</p>`;

    const go = (x, y) => { location.hash = href(x, y); };
    body().querySelector('#rv-a').addEventListener('change', (e) => go(e.target.value, b === e.target.value ? a : b));
    body().querySelector('#rv-b').addEventListener('change', (e) => go(a === e.target.value ? b : a, e.target.value));
    body().querySelector('#rv-swap').addEventListener('click', () => go(b, a));
  }

  // ---------- all-time records ----------
  // Game lists come from each season's games.json (tools/run-games.js: ESPN scores, regular season, every
  // in-league and cross-league game) plus the playoff scores in each past season's playoffs.json. Season totals
  // (records, PF, PA) come from data/history.json, the same numbers League History shows, for finished seasons only.
  async function renderRecords() {
    const token = renderToken;
    const body = () => document.getElementById('league-body');
    const json = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const years = SEASON_PAGES.filter((y) => y !== SEASON);
    const dirOf = (y) => (y === SEASON ? 'data/' : `data/seasons/${y}/`);
    const [history, ...files] = await Promise.all([
      json('data/history.json'),
      ...[...years, SEASON].flatMap((y) => [json(`${dirOf(y)}games.json`), json(`${dirOf(y)}standings.json`), y === SEASON ? null : json(`${dirOf(y)}playoffs.json`)]),
    ]);
    if (token !== renderToken) return;
    const seasons = [...years, SEASON].map((y, i) => ({ year: y, games: files[i * 3], standings: files[i * 3 + 1], playoffs: files[i * 3 + 2] }))
      .filter((s) => s.games && s.games.season === s.year);
    if (!history || !seasons.length) {
      body().innerHTML = '<div class="state state-error" role="alert"><strong>Couldn\'t load the records.</strong><a class="btn" href="#/archives/records" onclick="window.dispatchEvent(new HashChangeEvent(\'hashchange\'));return false;">Try again</a></div>';
      return;
    }

    // Everyone, by season and key ("league:teamId"): team name, owner, league and that season's logo.
    const who = new Map();
    for (const s of seasons) {
      const logos = new Map();
      for (const [slug, l] of Object.entries((s.standings && s.standings.leagues) || {})) for (const t of l.teams) logos.set(`${slug}:${t.id}`, t.logo);
      for (const [key, [name, owner]] of Object.entries(s.games.teams)) {
        const league = LEAGUES.find((l) => l.slug === key.split(':')[0]);
        who.set(`${s.year}|${key}`, { key, year: s.year, name, owner, league, logo: logos.get(key) });
      }
    }
    const team = (year, key) => who.get(`${year}|${key}`);
    const link = (year, hash) => (year === SEASON ? hash : `${year}.html${hash}`);

    // Every game, from both sides; every team-week score.
    const sides = []; // { t, year, week, pf, pa, opp, result, link, inLeague }
    const weekly = new Map(); // `${year}|${key}|${week}` -> { t, year, week, pf, games: [] }
    const matchups = []; // { t: winner, opp, year, week, pf, pa, margin, link }
    for (const s of seasons) {
      for (const [week, a, sa, b, sb, hash] of s.games.games) {
        const inLeague = hash.includes('/matchups');
        const pair = [[a, sa, b, sb], [b, sb, a, sa]];
        for (const [me, pf, opp, pa] of b === 'median' ? pair.slice(0, 1) : pair) {
          const side = {
            t: team(s.year, me), year: s.year, week, pf, pa, inLeague, link: link(s.year, hash),
            opp: opp === 'median' ? null : team(s.year, opp),
            result: pf > pa ? 'W' : pf < pa ? 'L' : 'T',
          };
          sides.push(side);
          const id = `${s.year}|${me}|${week}`;
          if (!weekly.has(id)) weekly.set(id, { t: side.t, year: s.year, week, pf, link: side.link, games: [] });
          const w = weekly.get(id);
          w.games.push(side);
          if (inLeague) w.link = side.link; // a week's score links to its in-league game when there is one
        }
        // Head-to-head games once each, winner first (not 2023's games against the median)
        if (b !== 'median') {
          const [win, lose, ws, ls] = sa >= sb ? [a, b, sa, sb] : [b, a, sb, sa];
          matchups.push({ t: team(s.year, win), opp: team(s.year, lose), year: s.year, week, pf: ws, pa: ls, margin: Math.round((ws - ls) * 100) / 100, link: link(s.year, hash) });
        }
      }
    }
    // Playoff weeks of past seasons (each team's one game a week), for the single-week score lists.
    const scores = [...weekly.values()].map((w) => ({ ...w, label: '' }));
    for (const s of seasons) {
      if (!s.playoffs) continue;
      s.playoffs.games.forEach((g, i) => {
        for (const side of g.teams) {
          const t = [...who.values()].find((x) => x.year === s.year && x.owner === side.owner && (!g.league || x.league.slug === g.league));
          if (t) scores.push({ t, year: s.year, week: g.week, pf: side.score, link: link(s.year, playoffGameLink(g, i)), label: g.name || g.title });
        }
      });
    }

    const oppName = (x) => (x.opp ? `${esc(x.opp.owner)} ${f2(x.pa)}` : `the median ${f2(x.pa)}`);
    const when = (x) => `${x.year} · Wk ${x.week}`;
    const gameRow = (x) => ({
      t: x.t, when: when(x), value: f2(x.margin), link: x.link,
      note: `${x.margin ? 'Beat' : 'Tied'} ${esc(x.opp.owner)} ${f2(x.pf)}–${f2(x.pa)}`,
    });
    const scoreRow = (x) => ({ t: x.t, when: `${when(x)}${x.label ? ` · ${esc(x.label)}` : ''}`, value: f2(x.pf), link: x.link });
    const top = (list, n, val, dir) => list.slice().sort((a, b) => (dir === 'asc' ? val(a) - val(b) : val(b) - val(a))).slice(0, n);

    // Finished seasons' totals, as League History has them.
    const seasonRows = [];
    for (const [year, season] of Object.entries(history.seasons)) {
      const y = Number(year);
      if (y === SEASON) continue;
      for (const t of season.teams) {
        const found = [...who.values()].find((x) => x.year === y && x.owner === t.owner && x.league.slug === t.league);
        const league = LEAGUES.find((l) => l.slug === t.league);
        const ties = t.t || 0;
        seasonRows.push({
          t: found || { name: t.team, owner: t.owner, league, logo: null },
          year: y, w: t.w, l: t.l, ties, pct: (t.w + ties / 2) / (t.w + t.l + ties), pf: t.pf, pa: t.pa,
          ppg: t.pf / ((t.w + t.l + ties) / 2), // two games a week, as League History's PPG
          link: SEASON_PAGES.includes(y) ? `${y}.html#/home/final-standings` : `#/archives/history?year=${y}`,
        });
      }
    }
    const rec = (x) => `${x.w}-${x.l}${x.ties ? `-${x.ties}` : ''}`;
    const seasonRow = (value) => (x) => ({ t: x.t, when: String(x.year), value: value(x), note: `${rec(x)} · ${f2(x.pf)} PF`, link: x.link });
    const withPpg = (r, x) => Object.assign(r, { extra: f2(x.ppg) });

    // Luck in finished seasons, worked out as each season's Luck Index tab does: actual wins minus the wins its
    // all-play rate gives, over the regular season (in-league and cross-league games).
    const luckRows = [];
    for (const s of seasons) {
      if (s.year === SEASON || !s.standings || s.standings.season !== s.year) continue;
      const entries = LEAGUES.filter((cfg) => s.standings.leagues[cfg.slug]).flatMap((cfg) => {
        const { league, results } = lockedLeague(s.standings, cfg);
        return league.teams.map((tm) => ({ team: tm, league, results: results.get(tm.id) }));
      });
      entries.sort((a, b) => b.team.pct - a.team.pct || b.team.pf - a.team.pf).forEach((e, i) => { e.rank = i + 1; });
      for (const e of luckIndex(entries, s.standings.week)) {
        const tm = e.team;
        luckRows.push({
          t: team(s.year, `${e.league.slug}:${tm.id}`) || { name: tm.name, owner: tm.owner, league: LEAGUES.find((l) => l.slug === e.league.slug), logo: tm.logo },
          year: s.year, luck: Math.round(e.luck * 10) / 10, expected: e.expected,
          rec: `${tm.wins}-${tm.losses}${tm.ties ? `-${tm.ties}` : ''}`, link: `${s.year}.html#/home/luck-index`,
        });
      }
    }
    const luckRow = (x) => ({
      t: x.t, when: String(x.year), link: x.link,
      value: `${x.luck > 0 ? '+' : x.luck < 0 ? '−' : ''}${Math.abs(x.luck).toFixed(1)}`,
      note: `${x.rec} · ${f1(x.expected)} expected wins`,
    });

    // A team's week where it played twice or more and lost (or won) them all.
    const sweeps = (result) => [...weekly.values()].filter((w) => w.games.length >= 2 && w.games.every((g) => g.result === result));
    const sweepNote = (w) => `${w.games[0].result === 'L' ? 'Lost to' : 'Beat'} ${w.games.map(oppName).join(' and ')}`;
    // One row per team-week, so a week with two losses (or wins) on the same score is listed once, naming both
    // opponents; it links to that week's losing (or winning) game.
    const withResult = (result) => [...weekly.values()].filter((w) => w.games.some((g) => g.result === result))
      .map((w) => ({ ...w, link: w.games.find((g) => g.result === result).link }));
    const resultNote = (w, result) => `${result === 'L' ? 'Lost to' : 'Beat'} ${w.games.filter((g) => g.result === result).map(oppName).join(' and ')}`;

    // Streaks within a season, a week's games in streakOrder().
    const streaks = { W: [], L: [] };
    const latest = Math.max(...sides.filter((x) => x.year === SEASON).map((x) => x.week), 0);
    for (const s of seasons) {
      const mine = new Map();
      for (const x of sides) if (x.year === s.year) (mine.get(x.t.key) || mine.set(x.t.key, []).get(x.t.key)).push(x);
      for (const list of mine.values()) {
        list.sort((a, b) => a.week - b.week || b.inLeague - a.inLeague);
        let run = null;
        const close = () => { if (run && run.n >= 2) streaks[run.result].push(run); run = null; };
        for (let k = 0; k < list.length;) {
          const week = [];
          while (k < list.length && list[k].week === (week[0] || list[k]).week) week.push(list[k++]);
          for (const x of streakOrder(week, run && run.result)) {
            if (run && run.result === x.result) { run.n++; run.end = x.week; continue; }
            close();
            if (x.result !== 'T') run = { t: x.t, year: s.year, result: x.result, n: 1, start: x.week, end: x.week };
          }
        }
        if (run && s.year === SEASON && run.end === latest) run.active = true;
        close();
      }
    }
    const streakRow = (x) => ({
      t: x.t, when: `${x.year} · Wk ${x.start}${x.end !== x.start ? `–${x.end}` : ''}`, value: `${x.n} ${x.result === 'W' ? 'wins' : 'losses'}`,
      // Links to the team's roster page, whose season schedule shows the streak game by game.
      note: x.active ? '<b class="rec-active">Active</b>' : '',
      link: link(x.year, `#/${x.t.league.slug}/rosters?team=${x.t.key.split(':')[1]}`),
    });

    const sections = [
      ['Highest single-week scores', 50, top(scores, 50, (x) => x.pf).map(scoreRow), 'Score'],
      ['Lowest single-week scores', 50, top(scores, 50, (x) => x.pf, 'asc').map(scoreRow), 'Score'],
      ['Best regular-season records', 30, top(seasonRows, 30, (x) => x.pct + x.pf / 1e6).map(seasonRow(rec)), 'Record'],
      ['Worst regular-season records', 30, top(seasonRows, 30, (x) => x.pct + x.pf / 1e6, 'asc').map(seasonRow(rec)), 'Record'],
      ['Most regular-season points for', 30, top(seasonRows, 30, (x) => x.pf).map((x) => withPpg(seasonRow((y) => f2(y.pf))(x), x)), 'PF', 'PPG'],
      ['Fewest regular-season points for', 30, top(seasonRows, 30, (x) => x.pf, 'asc').map((x) => withPpg(seasonRow((y) => f2(y.pf))(x), x)), 'PF', 'PPG'],
      ['Most regular-season points against', 30, top(seasonRows, 30, (x) => x.pa).map(seasonRow((x) => f2(x.pa))), 'PA'],
      ['Fewest regular-season points against', 30, top(seasonRows, 30, (x) => x.pa, 'asc').map(seasonRow((x) => f2(x.pa))), 'PA'],
      ['Most points in a loss', 30, top(withResult('L'), 30, (x) => x.pf)
        .map((x) => ({ t: x.t, when: when(x), value: f2(x.pf), note: resultNote(x, 'L'), link: x.link })), 'Score'],
      ['Most points in an 0-2 week', 15, top(sweeps('L'), 15, (x) => x.pf)
        .map((x) => ({ t: x.t, when: when(x), value: f2(x.pf), note: sweepNote(x), link: x.link })), 'Score'],
      ['Fewest points in a win', 30, top(withResult('W'), 30, (x) => x.pf, 'asc')
        .map((x) => ({ t: x.t, when: when(x), value: f2(x.pf), note: resultNote(x, 'W'), link: x.link })), 'Score'],
      ['Fewest points in a 2-0 week', 15, top(sweeps('W'), 15, (x) => x.pf, 'asc')
        .map((x) => ({ t: x.t, when: when(x), value: f2(x.pf), note: sweepNote(x), link: x.link })), 'Score'],
      ['Luckiest seasons', 15, top(luckRows, 15, (x) => x.luck).map(luckRow), 'Luck'],
      ['Unluckiest seasons', 15, top(luckRows, 15, (x) => x.luck, 'asc').map(luckRow), 'Luck'],
      ['Longest winning streaks', 10, top(streaks.W, 10, (x) => x.n).map(streakRow), 'Streak'],
      ['Longest losing streaks', 10, top(streaks.L, 10, (x) => x.n).map(streakRow), 'Streak'],
      ['Biggest blowouts', 30, top(matchups, 30, (x) => x.margin).map(gameRow), 'Margin'],
      ['Closest games', 30, top(matchups, 30, (x) => x.margin, 'asc').map(gameRow), 'Margin'],
    ];

    // Ranks share a number on an exact tie (1, 2, 2, 4).
    // An optional fifth entry names an extra column, left of the main one, from each row's `extra`.
    const table = ([title, n, rows, head, extraHead]) => {
      let rank = 0;
      const body = rows.map((r, i) => {
        if (i === 0 || r.value !== rows[i - 1].value) rank = i + 1;
        const lg = r.t.league;
        return `
          <tr class="lg-row" style="--lc:var(--${lg.theme})">
            <td class="c-rank"><span class="rank">${rank}</span></td>
            <td class="c-team"><a class="team-cell" href="${r.link}">
              ${teamLogo({ logo: r.t.logo }, lg)}
              <span><strong>${esc(r.t.name)}</strong><small>${esc(r.t.owner)}</small><small class="lg-name">${esc(lg.name)}</small><small class="rec-sub">${r.when}${r.note ? `<br>${r.note}` : ''}</small></span>
            </a></td>
            <td class="c-when">${r.when}${r.note ? `<small>${r.note}</small>` : ''}</td>
            ${extraHead ? `<td class="c-num c-extra">${esc(r.extra)}</td>` : ''}
            <td class="c-num c-val">${esc(r.value)}</td>
          </tr>`;
      }).join('');
      const first = rows[0];
      return `
        <details class="panel rec-section">
          <summary>
            <span class="rec-title"><strong>${esc(title)}</strong><small>Top ${n}</small></span>
            ${first ? `<span class="rec-lead">${esc(first.t.owner)} · ${esc(first.value)}</span>` : ''}
          </summary>
          <div class="table-wrap"><table class="standings rec-table">
            <thead><tr><th class="c-rank">#</th><th>Team</th><th class="c-when">When</th>${extraHead ? `<th class="c-num" title="Points per game: average weekly score">${esc(extraHead)}</th>` : ''}<th class="c-num">${esc(head)}</th></tr></thead>
            <tbody>${body || `<tr><td colspan="${extraHead ? 5 : 4}" class="muted">Nothing yet.</td></tr>`}</tbody>
          </table></div>
        </details>`;
    };
    const first = Math.min(...seasons.map((s) => s.year));
    body().innerHTML = `
      <p class="pw-status">All-time records from ${first} on. Tap a list to open it.</p>
      <div class="rec-list">${sections.map(table).join('')}</div>
      <p class="fineprint">Single-week scores, game lists and streaks use ESPN's scores and include the ${SEASON} season's finished weeks; single-week scores also count past seasons' playoff games. Season records, PF and PA are from finished seasons, as League History shows them; PA counts every opponent, in-league and cross-league. Streaks run within one season. In a 1-1 week, the result that continues a streak counts first, so the week adds one to the streak before ending it; a tie ends a streak. Luck is a finished season's actual wins minus expected wins, as each season's Luck Index has it: expected wins are the team's all-play win rate (its score each week against every other team's) times its games played, in-league and cross-league. ${history.seasons[2023] ? 'In 2023, a team on bye played the week’s median, and those games count, except in blowouts and closest games, which are head-to-head games only.' : ''}</p>`;
  }

  function placeholderPanel(art, kicker, title) {
    return `
      <section class="placeholder">
        <img class="placeholder-art" src="${art}" alt="" width="220" height="220">
        <p class="eyebrow">${esc(kicker)}</p>
        <h2 class="page-title">${esc(title)}</h2>
        <p class="placeholder-badge">In progress</p>
      </section>`;
  }

  // Past seasons from data/history.json (tools/build-history.py). A season with its own saved site shows each
  // team's logo from that season (data/seasons/<year>/standings.json). Otherwise managers still in the league
  // show their current team logo, found by first name in data/standings.json, and former managers their league's.
  const HISTORY_YEARS = [2025, 2024, 2023];
  const SEASON_PAGES = [2023, 2024, 2025]; // seasons with their own saved site (<year>.html, tools/build-season.js)

  async function renderHistory(params) {
    const token = renderToken;
    const body = () => document.getElementById('league-body');
    const json = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [file, standings] = await Promise.all([json('data/history.json'), json('data/standings.json')]);
    if (token !== renderToken) return;
    if (!file) {
      body().innerHTML = `<div class="state state-error" role="alert"><strong>Couldn't load league history.</strong><a class="btn" href="#/archives/history" onclick="window.dispatchEvent(new HashChangeEvent('hashchange'));return false;">Try again</a></div>`;
      return;
    }
    const current = new Map();
    for (const league of LEAGUES) {
      for (const team of (standings && standings.leagues[league.slug] || {}).teams || []) current.set(team.owner, team);
    }
    const ready = HISTORY_YEARS.filter((y) => file.seasons[y]);
    const asked = Number(params.get('year'));
    const year = HISTORY_YEARS.includes(asked) ? asked : ready[0] || HISTORY_YEARS[0];
    const season = file.seasons[year];
    const options = HISTORY_YEARS.map((y) =>
      `<option value="${y}" ${y === year ? 'selected' : ''}>${y} season${file.seasons[y] ? '' : ' · coming soon'}</option>`).join('');
    const bar = `
      <div class="matchups-bar hist-bar">
        <div class="rc-title"><p class="eyebrow">League history</p><h2>${year} Season</h2></div>
        <div class="hist-actions">
          ${SEASON_PAGES.includes(year) ? `<a class="season-link" href="${year}.html#/home">View the ${year} season<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ''}
          <label class="select"><span class="sr-only">Choose season</span><select id="year-select">${options}</select></label>
        </div>
      </div>`;
    const bind = () => body().querySelector('#year-select').addEventListener('change', (e) => {
      location.hash = `#/archives/history?year=${e.target.value}`;
    });
    if (!season) {
      body().innerHTML = `${bar}${placeholderPanel(PLACEHOLDERS.archives.art, 'Final standings', `${year} Season`)}`;
      bind();
      return;
    }

    const saved = SEASON_PAGES.includes(year) ? await json(`data/seasons/${year}/standings.json`) : null;
    if (token !== renderToken) return;
    const thatYear = new Map();
    for (const league of LEAGUES) {
      for (const team of (saved && saved.leagues[league.slug] || {}).teams || []) thatYear.set(`${league.slug}:${team.owner}`, team);
    }
    const leagueOf = (slug) => LEAGUES.find((l) => l.slug === slug);
    const logo = (t) => {
      const league = leagueOf(t.league);
      if (saved) return teamLogo({ logo: (thatYear.get(`${t.league}:${t.owner}`) || {}).logo }, league); // that year's logo, not a custom one
      return teamLogo(t.former ? null : current.get(t.owner), league);
    };
    const byOwner = new Map(season.teams.map((t) => [t.owner, t]));
    const score = (f) => `${f2(f.score)}–${f2(f.oppScore)}`;

    const award = (cls, badge, title, t, note) => {
      const league = leagueOf(t.league);
      return `
        <article class="hist-award ${cls}" style="--lc:var(--${league.theme})">
          <img class="hist-badge" src="${badge}" alt="" width="44" height="44">
          <p class="hist-award-title">${esc(title)}</p>
          <div class="hist-award-team">
            ${logo(t).replace('class="avatar"', 'class="avatar lg"')}
            <div><strong>${esc(t.owner)}</strong><small>${esc(t.team)}</small><small class="lg-name"><i class="dot"></i>${esc(league.name)}</small></div>
          </div>
          <p class="hist-award-note">${note}</p>
        </article>`;
    };
    const grand = byOwner.get(season.grandChampion);
    const loser = byOwner.get(season.ultimateLoser);
    const awards = [
      award('grand', 'assets/img/champs/grand-champion.png', 'Grand Champion', grand, grand.final.of > 2
        ? `Top score in the ${esc(grand.final.label)}: ${f2(grand.final.score)}, ahead of ${esc(grand.final.opp)}'s ${f2(grand.final.oppScore)}`
        : `Won the championship ${score(grand.final)} over ${esc(grand.final.opp)}`),
      ...season.leagues.map((slug) => {
        const t = byOwner.get(season.champions[slug]);
        const league = leagueOf(slug);
        return award('league', league.badge, `${league.name} Champion`, t, `${ordinal(t.seed)} seed · ${t.w}-${t.l}${t.t ? `-${t.t}` : ''} regular season`);
      }),
      // Each league's loser is its lowest finisher after the playoffs
      ...season.leagues.map((slug) => {
        const t = season.teams.filter((x) => x.league === slug).pop();
        const league = leagueOf(slug);
        return award('league-loser', league.logo, `${league.name} Loser`, t, `${ordinal(t.finish)} overall · ${ordinal(t.seed)} seed · ${t.w}-${t.l}${t.t ? `-${t.t}` : ''} regular season`);
      }),
      award('loser', 'assets/img/champs/ultimate-loser.png', 'Ultimate Loser', loser, loser.final.of > 2
        ? `Lowest score in the ${esc(loser.final.label)}: ${f2(loser.final.score)}, behind ${esc(loser.final.opp)}'s ${f2(loser.final.oppScore)}`
        : `Lost the Toilet Bowl ${score(loser.final)} to ${esc(loser.final.opp)}`),
    ].join('');

    const standingsPanel = finalStandings(season, season.teams, { logo });

    body().innerHTML = `
      ${bar}
      <section class="hist-awards" style="--cols:${season.leagues.length + 1}">${awards}</section>
      <h2 class="section-label">Final standings</h2>
      ${standingsPanel.html}
      <p class="fineprint">Finish is each team's final place after the playoffs. Records, PF and PA are from the regular season; ${season.medianByes ? 'Cross includes bye-week games against the median, and ' : ''}PA counts every opponent, so it runs about double PF. ${saved ? `Logos are each team's ${year} logo.` : `Managers still in the league show their current team logo; former managers show their league's logo.`}</p>`;
    bind();
    standingsPanel.bind(body());
  }

  // A season's standings after the playoffs, from data/history.json: League History, and the Final Standings
  // tabs of a past season's page. opts.logo(t) draws a team's logo. opts.inLeague numbers one league's teams
  // 1 to 9 and puts each team's overall finish under its name.
  function finalStandings(season, teams, opts) {
    const leagueOf = (slug) => LEAGUES.find((l) => l.slug === slug);
    const place = new Map(teams.slice().sort((a, b) => a.finish - b.finish).map((t, i) => [t.owner, opts.inLeague ? i + 1 : t.finish]));
    const row = (t) => {
      const league = leagueOf(t.league);
      const n = place.get(t.owner);
      const badges = [
        t.owner === season.grandChampion ? '<img class="champ goat" src="assets/img/champs/grand-champion.png" alt="Grand champion" title="Grand champion" width="17" height="17">' : '',
        season.champions[t.league] === t.owner ? `<img class="champ" src="${league.badge}" alt="${esc(league.name)} champion" title="${esc(league.name)} champion" width="17" height="17">` : '',
        t.owner === season.ultimateLoser ? '<img class="champ goat" src="assets/img/champs/ultimate-loser.png" alt="Ultimate loser" title="Ultimate loser" width="17" height="17">' : '',
      ].join('');
      const ties = t.t || 0; // 2025 had two in-league ties
      const weeks = (t.w + t.l + ties) / 2; // two games a week (bye weeks are two cross-league games)
      const split = (w, l, tied) => (w == null ? '—' : `${w}-${l}${tied ? `-${tied}` : ''}`);
      return `
        <tr class="lg-row ${n <= 3 ? `podium p${n}` : ''}" style="--lc:var(--${league.theme})">
          <td class="c-rank"><span class="rank">${n}</span></td>
          <td class="c-team">
            <div class="team-cell">
              ${opts.logo(t)}
              <span><strong>${esc(t.team)}</strong><small>${esc(t.owner)}${badges ? `<i class="champs">${badges}</i>` : ''}</small><small class="lg-name">${opts.inLeague ? `${ordinal(t.finish)} overall` : esc(league.name)}</small></span>
            </div>
          </td>
          <td class="c-num c-rec">${split(t.w, t.l, ties)}</td>
          <td class="c-num hide-sm muted">${split(t.inW, t.inL, t.inT)}</td>
          <td class="c-num hide-sm muted">${split(t.xW, t.xL)}</td>
          <td class="c-num">${f2(t.pf)}</td>
          <td class="c-num hide-sm">${weeks ? f2(t.pf / weeks) : '—'}</td>
          <td class="c-num hide-sm muted" title="In-league ${f2(t.pa - t.crossPa)} + cross-league ${f2(t.crossPa)}">${f2(t.pa)}</td>
        </tr>`;
    };
    // Click Finish / PF / PA to sort; click the active one again to flip direction. Finish "desc" puts 1st on top.
    let sort = { key: 'finish', dir: 'desc' };
    const table = () => {
      const val = (t) => (sort.key === 'finish' ? -t.finish : t[sort.key]);
      const list = teams.slice().sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)) || a.finish - b.finish);
      return `
          <table class="standings hist-table">
            <thead><tr>
              ${sortHeader(sort, 'finish', 'Finish', 'c-rank', 'Sort by final place after the playoffs')}<th>Team</th>
              <th class="c-num">Overall</th>
              <th class="c-num hide-sm" title="In-league record">League</th><th class="c-num hide-sm" title="Cross-league record, including bye-week games">Cross</th>
              ${sortHeader(sort, 'pf', 'PF', 'c-num', 'Sort by points for')}<th class="c-num hide-sm" title="Points per game: average weekly score">PPG</th>${sortHeader(sort, 'pa', 'PA', 'c-num hide-sm', 'Sort by points against, in-league and cross-league')}
            </tr></thead>
            <tbody>${list.map(row).join('')}</tbody>
          </table>`;
    };
    return {
      html: `
        <p class="pw-sort">Table sortable by Finish, PF, and PA</p>
        <div class="panel st-panel ${standingsExpanded ? 'st-expanded' : ''}">
          <button class="toggle st-expand" type="button" aria-expanded="${standingsExpanded}">${standingsExpanded ? 'Show fewer columns' : 'Show all columns'}</button>
          <p class="st-hint">Swipe the table sideways to see every column</p>
          <div class="table-wrap">${table()}</div>
        </div>`,
      bind(root) {
        const wrap = root.querySelector('.table-wrap');
        wrap.addEventListener('click', (e) => {
          const btn = e.target.closest('th button[data-sort]');
          if (!btn) return;
          const key = btn.dataset.sort;
          sort = key === sort.key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
          wrap.innerHTML = table();
          wrap.querySelector(`th button[data-sort="${key}"]`).focus();
        });
      },
    };
  }

  // A past season's Final Standings tab: everyone on Home, one league on its own page. Logos are that season's.
  async function renderSeasonFinal(body, token, slug) {
    const [hist, file] = await Promise.all([
      fetch('data/history.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      lockedStandings(),
    ]);
    if (token !== renderToken) return;
    const season = hist && hist.seasons[SEASON];
    if (!season || !file) {
      body().innerHTML = '<div class="state state-error" role="alert"><strong>Couldn\'t load the final standings.</strong></div>';
      return;
    }
    const teamOf = new Map(LEAGUES.flatMap((cfg) => file.leagues[cfg.slug].teams.map((t) => [t.owner, t])));
    const teams = slug ? season.teams.filter((t) => t.league === slug) : season.teams;
    const panel = finalStandings(season, teams, {
      inLeague: !!slug,
      logo: (t) => teamLogo(teamOf.get(t.owner), LEAGUES.find((l) => l.slug === t.league)),
    });
    const name = slug ? LEAGUES.find((l) => l.slug === slug).name : '';
    body().innerHTML = `
      <p class="pw-status">${slug ? `Where each ${esc(name)} team finished after the playoffs.` : 'Where every team finished after the playoffs.'}</p>
      ${panel.html}
      <p class="fineprint">${slug
        ? `Finish is each team's place among ${esc(name)} teams after the playoffs, with its overall place under its name.`
        : 'Finish is each team\'s final place after the playoffs, from the Playoffs and Toilet Bowl brackets.'} Records, PF and PA are from the regular season; ${ARCHIVE && ARCHIVE.medianByes ? 'Cross includes bye-week games against the median, and ' : ''}PA counts every opponent, so it runs about double PF.</p>`;
    panel.bind(body());
  }

  // Weekly recaps: written on the site (the recap editor below; supabase/schema.sql's recaps table), and Weeks 1-9
  // of 2026 from data/recaps.json (tools/build-recaps.py). Each kind of section has its own look.
  const RECAP_ICONS = {
    game: '<ellipse cx="12" cy="12" rx="10" ry="6.2" transform="rotate(-35 12 12)"/><path d="M8.6 15.4l6.8-6.8M10 11.6l2.4 2.4M11.6 10l2.4 2.4M8.4 13.2l2.4 2.4" class="ink"/>',
    upset: '<path d="M13.5 2L4 13.5h6.5L9 22l10-12.5h-6.6z"/>',
    badbeat: '<path d="M12 21s-8.5-5.3-8.5-11.2A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 8.5 2.8C20.5 15.7 12 21 12 21z"/><path d="M12 7l-1.6 4 2.8 2.2-1.8 4.3" class="ink"/>',
    lucky: '<circle cx="8.6" cy="8.6" r="3.9"/><circle cx="15.4" cy="8.6" r="3.9"/><circle cx="8.6" cy="15.4" r="3.9"/><circle cx="15.4" cy="15.4" r="3.9"/><path d="M14 14c2.5 2.5 3.5 5 3.5 8" class="ink stem"/>',
    dawg: '<ellipse cx="12" cy="16.3" rx="5" ry="4.2"/><ellipse cx="5.4" cy="10.4" rx="2.1" ry="2.7"/><ellipse cx="9.4" cy="6.4" rx="2.1" ry="2.8"/><ellipse cx="14.6" cy="6.4" rx="2.1" ry="2.8"/><ellipse cx="18.6" cy="10.4" rx="2.1" ry="2.7"/>',
    challenger: '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8-5.1-4.7 6.9-.8z"/>',
    funfact: '<path d="M9 2.5h6M10 2.5v6.2L4.6 18.4A2 2 0 0 0 6.3 21.5h11.4a2 2 0 0 0 1.7-3.1L14 8.7V2.5" class="ink line"/><path d="M7.2 14h9.6l2.6 4.4a2 2 0 0 1-1.7 3.1H6.3a2 2 0 0 1-1.7-3.1z"/>',
  };
  const RECAP_HM = { game: 'Honorable mention', upset: 'Honorable mention', badbeat: 'Honorable mention', lucky: 'Honorable mention', dawg: 'Honorable mention', funfact: 'Fun fact', challenger: 'Honorable mention' };

  // Doc formatting: *italic* and ~~struck~~
  const recapText = (s) => esc(s).replace(/~~(.+?)~~/g, '<s>$1</s>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  const recapBody = (body) => body.map((b) => (Array.isArray(b)
    ? `<ul>${b.map((li) => `<li>${recapText(li)}</li>`).join('')}</ul>`
    : `<p>${recapText(b)}</p>`)).join('');

  // Scorecard sides find their team by manager first name (unique across the four leagues) in data/standings.json.
  // The card links to the game: the cross-league game when the winner's cross-league opponent that week is the
  // loser, otherwise the winner's in-league game.
  function recapGameLink(o, opp, week) {
    if (!o) return null;
    const cross = opp && (o.team.crossGames || []).find((g) => g.week === week && g.opp
      && String(g.opp.id) === String(opp.team.id) && g.oppLeague && g.oppLeague.slug === opp.league.slug);
    if (cross) {
      const slot = (o.team.crossSchedule || []).find((x) => x[0] === week && x[1] === `${opp.league.slug}:${opp.team.id}`);
      return `#/cross-league?week=${week}${slot && slot[2] ? `&game=${slot[2]}` : ''}`;
    }
    return `#/${o.league.slug}/matchups?week=${week}&team=${o.team.id}`;
  }

  function recapScore(score, owners, week) {
    const [[wName, wPts], [lName, lPts]] = score;
    const link = recapGameLink(owners.get(wName), owners.get(lName), week);
    const side = (name, pts, win) => {
      const o = owners.get(name);
      return `<div class="rc-side ${win ? 'win' : ''}" ${o ? `style="--c:var(--${o.league.theme})"` : ''}>
        ${o ? teamLogo(o.team, o.league, 'avatar rc-av') : ''}
        <div class="rc-who">
          <span class="rc-name">${o ? '<i class="dot"></i>' : ''}${esc(name)}</span>
          ${o ? `<small>${esc(o.team.name)}</small>` : ''}
        </div>
        <b>${pts.toFixed(2)}</b>
      </div>`;
    };
    const tag = link ? 'a' : 'div';
    return `<${tag} class="rc-score" ${link ? `href="${link}"` : ''} aria-label="${esc(wName)} beat ${esc(lName)} ${wPts.toFixed(2)} to ${lPts.toFixed(2)}${link ? ', view matchup' : ''}">
      ${side(wName, wPts, true)}${side(lName, lPts, false)}
      <p class="rc-margin">Final · by ${(wPts - lPts).toFixed(2)}${link ? '<span class="rc-view">View matchup ›</span>' : ''}</p>
    </${tag}>`;
  }

  // A section's (or honorable mention's) picture or GIF. Pictures are files in the editor's post-media folder.
  function recapMedia(m) {
    if (!m || !m.src || !m.w || !m.h) return '';
    const gif = m.kind === 'gif';
    if (gif ? !GIPHY_HOST.test(m.src) : !(ACCOUNT && /^[a-z0-9-]+\/[\w.-]+$/i.test(m.src))) return '';
    const src = gif ? m.src : ACCOUNT.mediaUrl(m.src);
    return `<a class="post-media rc-media" href="${esc(src)}" target="_blank" rel="noopener noreferrer">${mediaImg(src, m.w, m.h, gif ? 'GIF' : 'Picture')}</a>`;
  }
  const hasText = (body) => Array.isArray(body) && body.length > 0;

  // key: the section's reactions key (its kind, plus -2, -3… when a week has more than one of a kind).
  function recapSection(s, owners, week, key = slugify(s.kind)) {
    const hm = (s.hm || []).map((h, i) => `
      <div class="rc-hm">
        <p class="rc-hm-tag">${s.kind === 'funfact' ? `Fun fact #${i + 2}` : RECAP_HM[s.kind]}</p>
        ${recapBody(h.body || [])}
        ${recapMedia(h.media)}
        ${hasText(h.update) ? `<div class="rc-update"><p class="rc-hm-tag">Update</p>${recapBody(h.update)}</div>` : ''}
        ${h.score ? recapScore(h.score, owners, week) : ''}
      </div>`).join('');
    return `
      <article class="rc-card rc-${esc(s.kind)}" data-kind="${esc(key)}">
        <header class="rc-head">
          <svg class="rc-icon" viewBox="0 0 24 24" aria-hidden="true">${RECAP_ICONS[s.kind] || ''}</svg>
          <h3>${recapText(s.label || '')}</h3>
        </header>
        ${hasText(s.body) ? `<div class="rc-body">${recapBody(s.body)}</div>` : ''}
        ${recapMedia(s.media)}
        ${hasText(s.update) ? `<div class="rc-update"><p class="rc-hm-tag">Update</p>${recapBody(s.update)}</div>` : ''}
        ${s.score ? recapScore(s.score, owners, week) : ''}
        ${hm}
      </article>`;
  }
  // Reactions keys for a week's sections, in order.
  function recapKeys(sections) {
    const seen = new Map();
    return sections.map((s) => {
      const k = slugify(s.kind);
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      return n > 1 ? `${k}-${n}` : k;
    });
  }
  function recapPage(recap, owners) {
    const keys = recapKeys(recap.sections);
    return `${hasText(recap.intro) ? `<div class="rc-lede">${recapBody(recap.intro)}</div>` : ''}
      ${recap.sections.map((s, i) => recapSection(s, owners, recap.week, keys[i])).join('')}`;
  }

  const fetchJson = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  function ownersFrom(standings) {
    const owners = new Map();
    for (const league of LEAGUES) {
      for (const team of (standings && standings.leagues[league.slug] || {}).teams || []) owners.set(team.owner, { team, league });
    }
    return owners;
  }
  const recapsOnSite = () => Boolean(ACCOUNT && ACCOUNT.enabled && !ARCHIVE);
  const isRecapEditor = () => Boolean(recapsOnSite() && ACCOUNT.state.me && ACCOUNT.state.me.recap_editor);

  // Every recap readers can see: the ones written before the editor (data/recaps.json, Weeks 1-9), and the
  // ones published on the site, which take a week's place. Null when neither could be read.
  async function loadRecaps() {
    const [file, rows] = await Promise.all([fetchJson('data/recaps.json'),
      recapsOnSite() ? ACCOUNT.read('list_recaps', { p_season: SEASON }).catch(() => null) : Promise.resolve([])]);
    if (!file && !rows) return null;
    const weeks = new Map(((file && file.weeks) || []).map((w) => [w.week, w]));
    for (const r of rows || []) if (r.content) weeks.set(r.week, { week: r.week, intro: r.content.intro || [], sections: r.content.sections || [] });
    return [...weeks.values()].sort((a, b) => a.week - b.week);
  }

  let recapEditorShown = null; // whether the Recaps tab last drew with the editor's buttons
  async function renderRecaps(params) {
    if (params.has('edit')) return renderRecapEditor(Number(params.get('edit')));
    const token = renderToken;
    const body = () => document.getElementById('league-body');
    const [weeks, standings] = await Promise.all([loadRecaps(), fetchJson('data/standings.json')]);
    if (token !== renderToken) return;
    const editor = isRecapEditor();
    recapEditorShown = editor;
    const owners = ownersFrom(standings);
    if (!weeks || (!weeks.length && !editor)) {
      body().innerHTML = `<div class="state state-error" role="alert"><strong>Couldn't load the recaps.</strong><a class="btn" href="#/blog/recaps" onclick="window.dispatchEvent(new HashChangeEvent('hashchange'));return false;">Try again</a></div>`;
      return;
    }
    const latest = weeks.length ? weeks[weeks.length - 1].week : 0;
    const recap = weeks.find((w) => w.week === Number(params.get('week'))) || weeks[weeks.length - 1];
    const next = Math.min(18, latest + 1);
    const tools = editor ? `
      <div class="re-entry">
        <a class="btn" href="#/blog/recaps?edit=${next}">Write the Week ${next} recap</a>
        ${recap ? `<a class="btn-quiet" href="#/blog/recaps?edit=${recap.week}">Edit Week ${recap.week}</a>` : ''}
        <span>Only you can see these.</span>
      </div>` : '';
    if (!recap) {
      body().innerHTML = `<div class="recap">${tools}</div>`;
      return;
    }
    const options = weeks.slice().reverse().map((w) =>
      `<option value="${w.week}" ${w === recap ? 'selected' : ''}>Week ${w.week}${w.week === latest ? ' · latest' : ''}</option>`).join('');
    body().innerHTML = `
      <div class="recap">
        ${tools}
        <div class="matchups-bar">
          <div class="rc-title"><p class="eyebrow">${SEASON} · Weekly recap</p><h2>Week ${recap.week} Recap</h2></div>
          <label class="select"><span class="sr-only">Choose week</span><select id="week-select">${options}</select></label>
        </div>
        ${recapPage(recap, owners)}
      </div>`;
    body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/blog/recaps?week=${e.target.value}`;
    });
    // Each section gets its own reactions, e.g. recap:2026:w9:badbeat.
    attachReactions(body(), [...body().querySelectorAll('.recap .rc-card[data-kind]')].map((el) => ({
      el, target: `recap:${SEASON}:w${recap.week}:${el.dataset.kind}`,
    })));
  }

  // ---------- recap editor (recap editors only: managers.recap_editor in supabase/schema.sql) ----------
  // Blog > Recaps > Write / Edit opens #/blog/recaps?edit=<week>. Changes save as a draft a moment after each
  // edit; only editors see drafts. Publish shows the draft to everyone (and, the first time a week is published,
  // sends the "recap is up" notification).
  const RECAP_KINDS = [['game', 'Game of the Week'], ['upset', 'Upset of the Week'], ['badbeat', 'Bad beat of the week'],
    ['lucky', 'Lucky team of the week'], ['dawg', 'Dawg of the week'], ['funfact', 'Fun fact of the week'],
    ['challenger', 'A New Challenger Approaches']];
  const RECAP_KIND_NAMES = Object.fromEntries(RECAP_KINDS);
  const RECAP_KIND_COLORS = { game: 'dna', upset: 'rr', badbeat: 'loss', lucky: 'win', dawg: 'mm', funfact: 'dna', challenger: 'rr' };
  const newRecap = () => ({ intro: [], sections: ['game', 'upset', 'badbeat', 'lucky', 'dawg', 'funfact']
    .map((kind) => ({ kind, label: RECAP_KIND_NAMES[kind], body: [], hm: [] })) });
  const cloneRecap = (r) => {
    const c = JSON.parse(JSON.stringify({ intro: r.intro || [], sections: r.sections || [] }));
    for (const s of c.sections) s.hm = (s.hm || []).map(({ kind, label, ...h }) => h); // the old file repeats these
    return c;
  };
  // Text box <-> recap body: a blank line starts a new paragraph; lines starting with "- " are bullet points.
  const bodyToText = (body) => (body || []).map((b) => (Array.isArray(b) ? b.map((li) => `- ${li}`).join('\n') : b)).join('\n\n');
  function textToBody(text) {
    return String(text || '').replace(/\r/g, '').split(/\n[ \t]*\n/).map((c) => c.trim()).filter(Boolean).map((chunk) => {
      const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
      return lines.every((l) => /^[-•]\s+/.test(l)) ? lines.map((l) => l.replace(/^[-•]\s+/, '')) : lines.join(' ');
    });
  }

  let recapEd = null;
  const edBody = () => document.getElementById('league-body');
  // A block is a section ("s2") or one of its honorable mentions ("s2h0").
  function edBlock(t) {
    const m = /^s(\d+)(?:h(\d+))?$/.exec(t || '');
    const sec = m && recapEd.data.sections[Number(m[1])];
    if (!sec) return null;
    return m[2] === undefined ? sec : (sec.hm || [])[Number(m[2])] || null;
  }

  async function renderRecapEditor(week) {
    const token = renderToken;
    const say = (html) => { if (token === renderToken && edBody()) edBody().innerHTML = `<div class="state">${html}</div>`; };
    if (!(week >= 1 && week <= 18)) { location.hash = '#/blog/recaps'; return; }
    if (!recapsOnSite()) return say('<strong>Recaps can only be written on the live site.</strong>');
    if (!ACCOUNT.state.ready) return say('<strong>Checking your account…</strong>');
    if (!isRecapEditor()) {
      return say(`<strong>Only recap editors can write recaps.</strong><a class="btn" href="#/${ACCOUNT.state.user ? 'blog/recaps' : 'account'}">${ACCOUNT.state.user ? 'Back to recaps' : 'Sign in'}</a>`);
    }
    if (recapEd && recapEd.week === week) { if (recapEd.ready) { drawRecapEditor(); bindRecapEditor(); } return; }
    recapEd = { week, ready: false };
    edBody().innerHTML = loading('Loading the editor');
    let rows;
    try {
      rows = await ACCOUNT.write('recap_drafts', {});
    } catch (err) {
      return say(`<strong>Couldn’t open the editor.</strong><span>${esc(err.message)}</span>`);
    }
    const [file, games, standings] = await Promise.all([fetchJson('data/recaps.json'), fetchJson('data/games.json'), fetchJson('data/standings.json')]);
    if (token !== renderToken) return;
    const row = rows.find((r) => r.week === week);
    const fromFile = ((file && file.weeks) || []).find((w) => w.week === week) || null;
    const onSite = row && row.published_at ? row.content : null;
    const published = onSite || fromFile;
    recapEd = {
      week, ready: true,
      data: cloneRecap((row && row.draft) || published || newRecap()),
      published: published ? cloneRecap(published) : null,
      onSite: Boolean(onSite), fromFile: fromFile ? cloneRecap(fromFile) : null,
      hasDraft: Boolean(row && row.draft),
      weeks: new Map(rows.map((r) => [r.week, r.published_at ? (r.draft ? 'changes' : 'published') : 'draft'])),
      fileWeeks: new Set(((file && file.weeks) || []).map((w) => w.week)),
      games, owners: ownersFrom(standings),
      savedAt: row && row.draft ? row.updated_at : null,
      pending: false, saving: null, timer: 0, msg: '', error: false, view: 'edit', gif: null, pick: null, busy: '', field: null,
    };
    drawRecapEditor();
    bindRecapEditor();
  }

  function edStatusText(ed) {
    const state = ed.published ? (ed.hasDraft || ed.pending ? 'Published · with changes only you can see' : 'Published')
      : ed.hasDraft || ed.pending ? 'Draft · only you can see it' : 'New · not saved yet';
    const save = ed.saving ? 'Saving…' : ed.pending ? 'Unsaved changes' : ed.savedAt ? `Saved ${new Date(ed.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
    return `<b>${state}</b>${save ? ` · ${save}` : ''}`;
  }
  function edFoot() {
    const ed = recapEd;
    const changes = ed.hasDraft || ed.pending;
    const busy = Boolean(ed.busy);
    return `<div class="panel re-foot">
      <p class="re-status" aria-live="polite">${ed.busy ? esc(ed.busy) : edStatusText(ed)}</p>
      <div class="re-actions">
        ${changes && ed.published ? `<button type="button" class="btn-quiet" data-ed="discard"${busy ? ' disabled' : ''}>Discard changes</button>` : ''}
        ${changes && !ed.published ? `<button type="button" class="btn-quiet danger" data-ed="discard"${busy ? ' disabled' : ''}>Delete draft</button>` : ''}
        ${ed.onSite ? `<button type="button" class="btn-quiet danger" data-ed="unpublish"${busy ? ' disabled' : ''}>Unpublish</button>` : ''}
        <button type="button" class="btn" data-ed="publish"${!changes || busy ? ' disabled' : ''}>${ed.published ? 'Publish changes' : 'Publish'}</button>
      </div>
      ${ed.msg ? `<p class="acct-msg${ed.error ? ' error' : ''}" role="${ed.error ? 'alert' : 'status'}">${esc(ed.msg)}</p>` : ''}
    </div>`;
  }
  function edRedrawFoot() {
    const el = edBody() && edBody().querySelector('.re-foot');
    if (el && recapEd && recapEd.ready) el.outerHTML = edFoot();
  }

  const PHOTO_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  const textRows = (text, min) => Math.max(min, Math.min(18, Math.ceil(text.length / 70) + (text.match(/\n/g) || []).length + 1));
  function edText(field, body, label, placeholder, min = 3) {
    const text = bodyToText(body);
    return `<label class="sr-only" for="re-${field}">${esc(label)}</label>
      <textarea id="re-${field}" data-f="${field}" rows="${textRows(text, min)}" placeholder="${esc(placeholder)}">${esc(text)}</textarea>`;
  }
  // The week's saved games (data/games.json), winner first.
  function edGames() {
    const f = recapEd.games;
    if (!f || f.season !== SEASON) return [];
    const owner = (k) => (f.teams[k] || [])[1] || k;
    return f.games.filter((g) => g[0] === recapEd.week && g[3] !== 'median').map(([, a, sa, b, sb, link]) => {
      const [w, l] = sa >= sb ? [[a, sa], [b, sb]] : [[b, sb], [a, sa]];
      return { score: [[owner(w[0]), w[1]], [owner(l[0]), l[1]]], league: a.split(':')[0], cross: !String(link).includes('/matchups') };
    });
  }
  function edGamePicker(t) {
    const games = edGames();
    if (!games.length) {
      return `<div class="re-pick"><p class="gif-note">Week ${recapEd.week}'s games aren't saved yet. They're saved once the week is final, early Tuesday.</p>
        <div class="gif-foot"><span></span><button type="button" class="btn-quiet" data-ed="pick-close">Close</button></div></div>`;
    }
    const groups = [...LEAGUES.map((l) => [l.name, games.filter((g) => !g.cross && g.league === l.slug)]), ['Cross-league', games.filter((g) => g.cross)]];
    return `<div class="re-pick" role="group" aria-label="Pick a game">
      ${groups.filter(([, list]) => list.length).map(([name, list]) => `<p class="re-pick-head">${esc(name)}</p><div class="re-pick-list">
        ${list.map((g) => `<button type="button" class="re-game" data-ed="game" data-t="${t}" data-g="${games.indexOf(g)}">
          <span><b>${esc(g.score[0][0])}</b> ${g.score[0][1].toFixed(2)}</span><span class="re-game-vs">beat</span>
          <span>${esc(g.score[1][0])} ${g.score[1][1].toFixed(2)}</span><small>by ${(g.score[0][1] - g.score[1][1]).toFixed(2)}</small></button>`).join('')}
      </div>`).join('')}
      <div class="gif-foot"><span></span><button type="button" class="btn-quiet" data-ed="pick-close">Close</button></div>
    </div>`;
  }
  function edGifGrid(g) {
    if (g.error) return `<p class="gif-note error">${esc(g.error)}</p>`;
    if (g.loading && !g.items.length) return '<p class="gif-note">Loading GIFs…</p>';
    if (!g.items.length) return '<p class="gif-note">No GIFs found. Try other words.</p>';
    return g.items.map((it, i) => `<button type="button" class="gif-pick" data-ed="gif-pick" data-i="${i}" title="${esc(it.title)}" aria-label="${esc(it.title)}">
      <img src="${esc(it.thumb)}" alt="" loading="lazy"></button>`).join('');
  }
  function edBlockHtml(t, b, placeholder) {
    const ed = recapEd;
    const busy = Boolean(ed.busy);
    const extras = [];
    if (b.media) extras.push(`<div class="re-attached">${recapMedia(b.media)}<button type="button" class="btn-quiet danger" data-ed="media-x" data-t="${t}">Remove the ${b.media.kind === 'gif' ? 'GIF' : 'picture'}</button></div>`);
    if (b.update) {
      extras.push(`<div class="re-update"><div class="re-row"><p class="rc-hm-tag">Update</p><button type="button" class="btn-quiet danger" data-ed="update-x" data-t="${t}">Remove the update</button></div>
        ${edText(`${t}:update`, b.update, 'Update', 'An update posted after the recap went up…', 2)}</div>`);
    }
    if (b.score) extras.push(`<div class="re-attached re-scorecard">${recapScore(b.score, ed.owners, ed.week)}<button type="button" class="btn-quiet danger" data-ed="score-x" data-t="${t}">Remove the scorecard</button></div>`);
    const gif = ed.gif && ed.gif.t === t ? `
      <div class="gif-picker">
        <label class="sr-only" for="re-gif-q">Search GIFs</label>
        <input id="re-gif-q" type="search" placeholder="Search GIFs" value="${esc(ed.gif.q)}" autocomplete="off" enterkeyhint="search">
        <div class="gif-grid" aria-live="polite">${edGifGrid(ed.gif)}</div>
        <div class="gif-foot"><small>Powered by GIPHY</small><button type="button" class="btn-quiet" data-ed="gif-close">Close</button></div>
      </div>` : '';
    return `
      ${edText(`${t}:body`, b.body, 'Text', placeholder)}
      <div class="re-tools">
        <button type="button" class="re-fmt" data-ed="fmt" data-wrap="*" data-t="${t}" title="Italic (select words first)" aria-label="Italic"><i>I</i></button>
        <button type="button" class="re-fmt" data-ed="fmt" data-wrap="~~" data-t="${t}" title="Strikethrough (select words first)" aria-label="Strikethrough"><s>S</s></button>
        <label class="btn-quiet post-add${b.media || busy ? ' off' : ''}" title="Add a picture">${PHOTO_ICON}<span>Picture</span>
          <input type="file" accept="image/*" data-photo="${t}" aria-label="Add a picture"${b.media || busy ? ' disabled' : ''}></label>
        ${GIPHY_KEY ? `<button type="button" class="btn-quiet post-add" data-ed="gif" data-t="${t}"${b.media || busy ? ' disabled' : ''}><b class="gif-badge">GIF</b></button>` : ''}
        <button type="button" class="btn-quiet" data-ed="pick" data-t="${t}" aria-expanded="${ed.pick === t}">${b.score ? 'Change scorecard' : '+ Scorecard'}</button>
        ${b.update ? '' : `<button type="button" class="btn-quiet" data-ed="update" data-t="${t}">+ Update</button>`}
      </div>
      ${gif}${ed.pick === t ? edGamePicker(t) : ''}
      ${extras.join('')}`;
  }
  function edSectionHtml(s, i, count) {
    const funfact = s.kind === 'funfact';
    const hm = (s.hm || []).map((h, j) => `
      <div class="re-hm">
        <div class="re-row"><p class="rc-hm-tag">${funfact ? `Fun fact #${j + 2}` : `Honorable mention ${j + 1}`}</p>
          <button type="button" class="btn-quiet danger" data-ed="hm-x" data-t="s${i}h${j}">Remove</button></div>
        ${edBlockHtml(`s${i}h${j}`, h, funfact ? 'Another fun fact…' : 'An honorable mention…')}
      </div>`).join('');
    return `
      <section class="panel re-sec" data-s="${i}" style="--k:var(--${RECAP_KIND_COLORS[s.kind] || 'dna'})">
        <div class="re-row re-sec-head">
          <svg class="rc-icon" viewBox="0 0 24 24" aria-hidden="true">${RECAP_ICONS[s.kind] || ''}</svg>
          <label class="select"><span class="sr-only">Kind of section</span><select data-kind-of="${i}">
            ${RECAP_KINDS.map(([k, name]) => `<option value="${k}"${k === s.kind ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
          <span class="re-move">
            <button type="button" class="re-fmt" data-ed="up" data-i="${i}" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="re-fmt" data-ed="down" data-i="${i}" aria-label="Move down"${i === count - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="btn-quiet danger" data-ed="del" data-i="${i}">Delete</button>
          </span>
        </div>
        <label class="re-label"><span>Title</span><input id="re-s${i}:label" data-f="s${i}:label" value="${esc(s.label || '')}" maxlength="120"></label>
        ${edBlockHtml(`s${i}`, s, 'What happened…')}
        ${hm}
        <button type="button" class="btn-quiet re-add-hm" data-ed="hm-add" data-i="${i}">+ ${funfact ? 'Another fun fact' : 'Honorable mention'}</button>
      </section>`;
  }

  function drawRecapEditor() {
    const ed = recapEd;
    const el = edBody();
    if (!el || !ed || !ed.ready) return;
    const active = document.activeElement && document.activeElement.id;
    const caret = active && document.activeElement.selectionStart;
    const status = (w) => (w === ed.week ? '' : ed.weeks.get(w) === 'draft' ? ' · draft' : ed.weeks.get(w) === 'changes' ? ' · published, with changes'
      : ed.weeks.has(w) || ed.fileWeeks.has(w) ? ' · published' : '');
    const weekOptions = Array.from({ length: 17 }, (_, i) => i + 1).map((w) =>
      `<option value="${w}"${w === ed.week ? ' selected' : ''}>Week ${w}${status(w)}</option>`).join('');
    const preview = ed.view === 'preview';
    el.innerHTML = `
      <div class="recap re">
        <div class="matchups-bar">
          <div class="rc-title"><p class="eyebrow">${SEASON} · Recap editor</p><h2>Week ${ed.week} Recap</h2></div>
          <label class="select"><span class="sr-only">Choose week</span><select id="re-week">${weekOptions}</select></label>
        </div>
        <div class="re-row re-top">
          <div class="re-tabs" role="tablist" aria-label="Editor view">
            <button type="button" role="tab" aria-selected="${!preview}" data-ed="view" data-v="edit">Write</button>
            <button type="button" role="tab" aria-selected="${preview}" data-ed="view" data-v="preview">Preview</button>
          </div>
          <a class="btn-quiet" href="#/blog/recaps${ed.published ? `?week=${ed.week}` : ''}">Back to recaps</a>
        </div>
        ${preview ? `<p class="re-note">This is how readers will see it once it's published.</p>${recapPage({ ...ed.data, week: ed.week }, ed.owners)}` : `
        <p class="re-note">A blank line starts a new paragraph, and lines starting with “- ” become bullet points. Select words and tap <i>I</i> for italics or <s>S</s> to strike them out.</p>
        <section class="panel re-sec re-intro">
          <p class="re-sec-title">Intro</p>
          ${edText('intro', ed.data.intro, 'Intro', 'How the week went…', 4)}
          <div class="re-tools">
            <button type="button" class="re-fmt" data-ed="fmt" data-wrap="*" data-t="intro" title="Italic (select words first)" aria-label="Italic"><i>I</i></button>
            <button type="button" class="re-fmt" data-ed="fmt" data-wrap="~~" data-t="intro" title="Strikethrough (select words first)" aria-label="Strikethrough"><s>S</s></button>
          </div>
        </section>
        ${ed.data.sections.map((s, i) => edSectionHtml(s, i, ed.data.sections.length)).join('')}
        <div class="panel re-add">
          <label class="select"><span class="sr-only">Kind of section to add</span><select id="re-add-kind">
            ${RECAP_KINDS.map(([k, name]) => `<option value="${k}">${esc(name)}</option>`).join('')}</select></label>
          <button type="button" class="btn-quiet" data-ed="add">+ Add section</button>
        </div>`}
        ${edFoot()}
      </div>`;
    if (active) {
      const back = document.getElementById(active);
      if (back) {
        back.focus({ preventScroll: true });
        if (caret != null && back.setSelectionRange && back.type !== 'search') try { back.setSelectionRange(caret, caret); } catch { /* not a text box */ }
      }
    }
  }

  // Saves the draft a moment after the last change.
  function edChanged(redraw) {
    const ed = recapEd;
    ed.pending = true;
    ed.msg = '';
    clearTimeout(ed.timer);
    ed.timer = setTimeout(() => edSave(), 1200);
    if (redraw) drawRecapEditor(); else edRedrawFoot();
  }
  async function edSave() {
    const ed = recapEd;
    if (!ed || !ed.ready) return true;
    clearTimeout(ed.timer);
    if (ed.saving) await ed.saving;
    if (!ed.pending) return !ed.error;
    ed.pending = false;
    ed.saving = ACCOUNT.write('save_recap', { p_week: ed.week, p_draft: ed.data }).then((t) => {
      ed.savedAt = t;
      ed.hasDraft = true;
      ed.weeks.set(ed.week, ed.onSite ? 'changes' : 'draft');
      if (ed.error) { ed.msg = ''; ed.error = false; }
    }).catch((err) => {
      ed.pending = true;
      ed.msg = `Couldn’t save: ${err.message}`;
      ed.error = true;
    }).finally(() => {
      ed.saving = null;
      if (recapEd === ed) edRedrawFoot();
    });
    edRedrawFoot();
    await ed.saving;
    return !ed.pending;
  }

  async function edGifSearch(q) {
    const ed = recapEd;
    ed.gif = { ...ed.gif, q, loading: true, error: '' };
    try {
      const items = await searchGifs(q);
      if (!ed.gif || ed.gif.q !== q) return;
      ed.gif = { ...ed.gif, items, loading: false };
    } catch (err) {
      if (!ed.gif || ed.gif.q !== q) return;
      ed.gif = { ...ed.gif, items: [], loading: false, error: err.message };
    }
    const grid = edBody() && edBody().querySelector('.re .gif-grid');
    if (grid) { grid.innerHTML = edGifGrid(ed.gif); grid.scrollTop = 0; }
  }

  async function edAct(btn) {
    const ed = recapEd;
    const act = btn.dataset.ed;
    const t = btn.dataset.t;
    const i = Number(btn.dataset.i);
    const secs = ed.data.sections;
    const block = edBlock(t);
    switch (act) {
      case 'view': ed.view = btn.dataset.v; ed.gif = null; ed.pick = null; drawRecapEditor(); window.scrollTo({ top: 0 }); return;
      case 'fmt': {
        const box = document.getElementById(`re-${t === 'intro' ? 'intro' : ed.field && ed.field.startsWith(`${t}:`) && !ed.field.endsWith(':label') ? ed.field : `${t}:body`}`);
        if (!box) return;
        const [a, z] = [box.selectionStart, box.selectionEnd];
        const mark = btn.dataset.wrap;
        const picked = box.value.slice(a, z);
        box.value = box.value.slice(0, a) + mark + (picked || (mark === '*' ? 'italic words' : 'struck words')) + mark + box.value.slice(z);
        box.focus();
        box.setSelectionRange(a + mark.length, a + mark.length + (picked || (mark === '*' ? 'italic words' : 'struck words')).length);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      case 'up': case 'down': {
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= secs.length) return;
        [secs[i], secs[j]] = [secs[j], secs[i]];
        ed.gif = null; ed.pick = null;
        edChanged(true);
        const moved = edBody().querySelector(`.re-sec[data-s="${j}"]`);
        if (moved) moved.scrollIntoView({ block: 'nearest' });
        return;
      }
      case 'del':
        if (!confirm(`Delete the “${secs[i].label || RECAP_KIND_NAMES[secs[i].kind]}” section?`)) return;
        secs.splice(i, 1); ed.gif = null; ed.pick = null; edChanged(true); return;
      case 'add': {
        const kind = document.getElementById('re-add-kind').value;
        secs.push({ kind, label: RECAP_KIND_NAMES[kind], body: [], hm: [] });
        edChanged(true);
        const box = document.getElementById(`re-s${secs.length - 1}:body`);
        if (box) { box.focus(); box.scrollIntoView({ block: 'center' }); }
        return;
      }
      case 'hm-add': {
        (secs[i].hm = secs[i].hm || []).push({ body: [] });
        edChanged(true);
        const box = document.getElementById(`re-s${i}h${secs[i].hm.length - 1}:body`);
        if (box) box.focus();
        return;
      }
      case 'hm-x': {
        const [, s, h] = /^s(\d+)h(\d+)$/.exec(t);
        secs[s].hm.splice(Number(h), 1); ed.gif = null; ed.pick = null; edChanged(true); return;
      }
      case 'update': block.update = []; edChanged(true); { const box = document.getElementById(`re-${t}:update`); if (box) box.focus(); } return;
      case 'update-x': delete block.update; edChanged(true); return;
      case 'media-x': delete block.media; edChanged(true); return;
      case 'score-x': delete block.score; edChanged(true); return;
      case 'gif':
        ed.pick = null; ed.gif = { t, q: '', items: [], loading: true, error: '' };
        drawRecapEditor();
        { const q = document.getElementById('re-gif-q'); if (q) q.focus(); }
        edGifSearch('');
        return;
      case 'gif-close': ed.gif = null; drawRecapEditor(); return;
      case 'gif-pick': {
        const it = ed.gif && ed.gif.items[i];
        const target = edBlock(ed.gif && ed.gif.t);
        if (!it || !target) return;
        target.media = { kind: 'gif', src: it.url, w: it.w, h: it.h };
        ed.gif = null;
        edChanged(true);
        return;
      }
      case 'pick': ed.gif = null; ed.pick = ed.pick === t ? null : t; drawRecapEditor(); return;
      case 'pick-close': ed.pick = null; drawRecapEditor(); return;
      case 'game': {
        const g = edGames()[Number(btn.dataset.g)];
        if (!g || !block) return;
        block.score = g.score;
        ed.pick = null;
        edChanged(true);
        return;
      }
      case 'publish': {
        const first = !ed.published;
        if (first && !confirm(`Publish the Week ${ed.week} recap? Everyone will see it, and members with recap notifications on get one.`)) return;
        ed.busy = 'Publishing…'; edRedrawFoot();
        try {
          if (!(await edSave())) throw new Error(ed.msg || 'Couldn’t save the draft.');
          const isNew = await ACCOUNT.write('publish_recap', { p_week: ed.week });
          ed.published = cloneRecap(ed.data);
          ed.onSite = true;
          ed.hasDraft = false;
          ed.savedAt = null;
          ed.weeks.set(ed.week, 'published');
          ed.msg = 'Published.';
          ed.error = false;
          if (isNew) {
            try { await ACCOUNT.push({ action: 'recap' }); ed.msg = 'Published, and the notification is on its way.'; }
            catch (err) { ed.msg = 'Published, but the notification didn’t go out.'; console.error(err); }
          }
        } catch (err) {
          ed.msg = err.message; ed.error = true;
        }
        ed.busy = '';
        drawRecapEditor();
        return;
      }
      case 'discard': {
        const published = Boolean(ed.published);
        if (!confirm(published ? 'Throw away your changes and go back to the published recap?' : `Delete the Week ${ed.week} draft?`)) return;
        clearTimeout(ed.timer);
        ed.busy = published ? 'Discarding…' : 'Deleting…'; edRedrawFoot();
        try {
          if (ed.saving) await ed.saving;
          await ACCOUNT.write('save_recap', { p_week: ed.week, p_draft: null });
          ed.data = published ? cloneRecap(ed.published) : newRecap();
          ed.pending = false; ed.hasDraft = false; ed.savedAt = null;
          if (published) ed.weeks.set(ed.week, 'published'); else ed.weeks.delete(ed.week);
          ed.msg = published ? 'Changes discarded.' : 'Draft deleted.'; ed.error = false;
        } catch (err) {
          ed.msg = err.message; ed.error = true;
        }
        ed.busy = ''; ed.gif = null; ed.pick = null;
        drawRecapEditor();
        return;
      }
      case 'unpublish': {
        if (!confirm(`Take the Week ${ed.week} recap down? ${ed.fromFile ? 'Readers will see the version from before the editor again.' : 'Readers won’t see it until you publish it again.'} It stays here as a draft.`)) return;
        ed.busy = 'Unpublishing…'; edRedrawFoot();
        try {
          if (!(await edSave())) throw new Error(ed.msg || 'Couldn’t save the draft.');
          await ACCOUNT.write('unpublish_recap', { p_week: ed.week });
          ed.onSite = false;
          ed.published = ed.fromFile;
          ed.hasDraft = true;
          ed.weeks.set(ed.week, 'draft');
          ed.msg = 'Unpublished. It’s a draft again.'; ed.error = false;
        } catch (err) {
          ed.msg = err.message; ed.error = true;
        }
        ed.busy = '';
        drawRecapEditor();
        return;
      }
      default:
    }
  }

  async function edPhoto(input) {
    const ed = recapEd;
    const file = input.files && input.files[0];
    const t = input.dataset.photo;
    input.value = '';
    if (!file || !edBlock(t)) return;
    ed.busy = 'Uploading the picture…'; ed.gif = null; drawRecapEditor();
    try {
      const { blob, w, h } = await preparePostImage(file);
      const path = await ACCOUNT.uploadPostMedia(blob);
      const block = recapEd === ed && edBlock(t);
      if (block) block.media = { kind: 'image', src: path, w, h };
      ed.busy = '';
      edChanged(true);
    } catch (err) {
      ed.busy = ''; ed.msg = err.message; ed.error = true;
      drawRecapEditor();
    }
  }

  // Once per page: the handlers read recapEd as it is when they run.
  function bindRecapEditor() {
    const el = edBody();
    if (!el || el.dataset.reBound) return;
    el.dataset.reBound = '1';
    const current = () => (recapEd && recapEd.ready ? recapEd : null);
    el.addEventListener('input', (e) => {
      const ed = current();
      if (!ed) return;
      const box = e.target;
      if (box.id === 're-gif-q') {
        clearTimeout(gifTimer);
        gifTimer = setTimeout(() => { if (ed.gif) edGifSearch(box.value); }, 400);
        return;
      }
      const f = box.dataset.f;
      if (!f) return;
      if (box.tagName === 'TEXTAREA') {
        box.style.height = 'auto';
        box.style.height = `${box.scrollHeight + 2}px`;
      }
      if (f === 'intro') ed.data.intro = textToBody(box.value);
      else {
        const [t, part] = f.split(':');
        const block = edBlock(t);
        if (!block) return;
        if (part === 'label') block.label = box.value;
        else block[part] = textToBody(box.value);
      }
      edChanged(false);
    });
    el.addEventListener('focusin', (e) => {
      const ed = current();
      if (ed && e.target.dataset && e.target.dataset.f) ed.field = e.target.dataset.f;
    });
    el.addEventListener('change', async (e) => {
      const ed = current();
      if (!ed) return;
      const box = e.target;
      if (box.id === 're-week') {
        const to = Number(box.value);
        box.disabled = true;
        await edSave();
        location.hash = `#/blog/recaps?edit=${to}`;
        return;
      }
      if (box.dataset.photo) { edPhoto(box); return; }
      if (box.dataset.kindOf) {
        const s = ed.data.sections[Number(box.dataset.kindOf)];
        if (!s.label || s.label === RECAP_KIND_NAMES[s.kind]) s.label = RECAP_KIND_NAMES[box.value];
        s.kind = box.value;
        edChanged(true);
      }
    });
    el.addEventListener('click', (e) => {
      const ed = current();
      const btn = e.target.closest('[data-ed]');
      if (!ed || !btn || btn.disabled) return;
      if (ed.busy && !['view', 'gif-close', 'pick-close'].includes(btn.dataset.ed)) return;
      e.preventDefault();
      edAct(btn);
    });
  }
  // Leaving the editor (or switching weeks) saves what's left; closing the tab with unsaved changes asks first.
  window.addEventListener('hashchange', () => {
    const ed = recapEd;
    if (!ed) return;
    const { parts, params } = parseHash();
    if (parts[0] === 'blog' && parts[1] === 'recaps' && Number(params.get('edit')) === ed.week) return;
    if (ed.ready && (ed.pending || ed.saving)) edSave();
    recapEd = null;
  });
  window.addEventListener('beforeunload', (e) => {
    if (recapEd && recapEd.ready && (recapEd.pending || recapEd.saving)) { e.preventDefault(); e.returnValue = ''; }
  });
  // Signing in or out (or the account loading) changes whether the editor and its buttons show.
  if (ACCOUNT && !ARCHIVE) {
    ACCOUNT.onChange(() => {
      const { parts, params } = parseHash();
      if (parts[0] !== 'blog' || parts[1] !== 'recaps' || !edBody()) return;
      if (params.has('edit') ? !recapEd : recapEditorShown !== null && recapEditorShown !== isRecapEditor()) renderRecaps(params);
    });
  }

  // ---------- league shell ----------
  function leagueShell(league, sub) {
    return `
      <section class="league-hero">
        <img class="league-hero-logo" src="${league.logo}" alt="${esc(league.name)} logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow">Microgen Fantasy Football · ${SEASON}</p>
          <h1 class="page-title">${esc(league.name)}</h1>
        </div>
        <img class="league-hero-art" src="${league.art}" alt="" aria-hidden="true">
      </section>
      <nav class="subtabs ${SUBTABS.length === 4 ? 'four' : ''}" aria-label="${esc(league.name)} sections">
        ${SUBTABS.map((s) => `<a href="#/${league.slug}/${s}" class="${s === sub ? 'active' : ''}" ${s === sub ? 'aria-current="page"' : ''}>${subtabLabel(s)}</a>`).join('')}
      </nav>
      <div id="league-body">${loading()}</div>`;
  }

  async function renderLeague(cfg, sub, params) {
    const token = ++renderToken;
    document.body.dataset.theme = cfg.theme;
    document.title = `${cfg.name} ${subtabLabel(sub)} · Microgen Fantasy Football`;
    main.innerHTML = leagueShell(cfg, sub);
    const body = () => document.getElementById('league-body');
    try {
      // A draft doesn't change: this tab runs entirely from its saved file, with no live data.
      if (sub === 'draft-board') {
        await renderDraftBoard(cfg, body, token);
        return;
      }
      if (sub === 'final-standings') {
        await renderSeasonFinal(body, token, cfg.slug);
        return;
      }
      const file = await lockedStandings();
      if (token !== renderToken) return;
      if (file && sub === 'standings') {
        const { league, results } = lockedLeague(file, cfg);
        await renderStandings(league, body, token, results);
        return;
      }
      if (file && sub === 'power-rankings') {
        await renderPowerRankings(lockedLeague(file, cfg).league, body, token);
        return;
      }
      if (sub === 'transactions') {
        const teams = file ? lockedLeague(file, cfg).league.teams : (await ESPN.getLeague(cfg)).teams;
        await renderTransactions(cfg, teams, body, token);
        return;
      }
      const data = await ESPN.getLeague(cfg);
      if (token !== renderToken) return;
      const league = Object.assign({}, data, { slug: cfg.slug, logo: cfg.logo, art: cfg.art, displayName: cfg.name, theme: cfg.theme });
      // Records and rank everywhere on league pages are overall (in-league + cross-league).
      try {
        if (file) applyLocked(league, file.leagues[cfg.slug]);
        else applyOverall(league, (await overallRecords()).out);
      } catch (err) {
        console.warn('Cross-league records unavailable; showing in-league records', err);
      }
      if (token !== renderToken) return;
      if (sub === 'standings') await renderStandings(league, body, token);
      else if (sub === 'rosters') await renderRosters(league, body, params, token);
      else if (sub === 'power-rankings') await renderPowerRankings(league, body, token);
      else await renderMatchups(league, body, params, token);
    } catch (err) {
      if (token !== renderToken) return;
      console.error(err);
      body().innerHTML = errorBox(err, location.hash);
    }
  }

  // ---------- standings ----------
  // Saved weekly by tools/run-standings.js. Used only while it matches ESPN's current week, so a
  // missed or late run falls back to live data: slower, never wrong.
  let standingsFile = null;
  async function lockedStandings() {
    if (!standingsFile || Date.now() - standingsFile.t > 300000) {
      standingsFile = {
        t: Date.now(),
        p: fetch(`${DATA}standings.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      };
    }
    const [file, week] = await Promise.all([
      standingsFile.p,
      ESPN.getCurrentWeek(LEAGUES[0].id).catch(() => null), // can't reach ESPN: the file is still the best we have
    ]);
    return file && file.season === SEASON && (week == null || week === file.week) ? file : null;
  }

  // Rebuild a league's standings from the file, in the same shape the live path produces.
  function lockedLeague(file, cfg) {
    const saved = file.leagues[cfg.slug];
    return {
      league: {
        slug: cfg.slug, logo: cfg.logo, displayName: cfg.name, theme: cfg.theme,
        teams: saved.teams, currentWeek: file.week, playoffTeams: saved.playoffTeams, overall: true,
      },
      results: new Map(Object.entries(saved.results).map(([id, list]) => [Number(id), list])),
    };
  }

  // Put the file's overall records and order onto live league data (Rosters and Matchups).
  function applyLocked(league, saved) {
    const live = new Map(league.teams.map((t) => [t.id, t]));
    league.teams = saved.teams.filter((s) => live.has(s.id)).map((s) => {
      const { name, owner, logo, titles, grandTitles, ultimateLosses, ...records } = s;
      return Object.assign(live.get(s.id), records);
    });
    league.overall = true;
  }

  // Cross-league records and overall ranks for the Cross-League tab.
  function lockedCrossData(file) {
    const all = LEAGUES.flatMap((cfg) => file.leagues[cfg.slug].teams.map((t) => ({ key: `${cfg.slug}:${t.id}`, t })));
    const out = new Map(all.map(({ key, t }) => [key, { w: t.xW, l: t.xL, t: t.xT }]));
    all.sort((a, b) => b.t.pct - a.t.pct || b.t.pf - a.t.pf);
    return { out, ranks: new Map(all.map((e, i) => [e.key, i + 1])) };
  }

  // The Rosters schedule's cross-league games, in the same shape as crossSchedules().
  function lockedCrossSchedules(file) {
    const teams = new Map();
    for (const cfg of LEAGUES) {
      for (const t of file.leagues[cfg.slug].teams) teams.set(`${cfg.slug}:${t.id}`, { team: t, league: cfg });
    }
    const byTeam = new Map();
    const out = new Map();
    for (const [key, { team }] of teams) {
      byTeam.set(key, team.crossSchedule.map(([week, opp, game, bye]) => ({ week, opp: teams.get(opp), game, bye })));
      out.set(key, { games: team.crossGames });
    }
    return { byTeam, out };
  }

  async function renderStandings(league, body, token, savedResults) {
    const results = savedResults || await ESPN.getResults(league);
    if (token !== renderToken) return;
    body().innerHTML = standingsTable(
      league.teams.map((t) => ({ team: t, league, results: results.get(t.id) })),
      { overall: league.overall, currentWeek: league.currentWeek, playoffTeams: league.playoffTeams })
      + (ARCHIVE ? '' : '<section class="panel rank-chart" id="rank-chart"></section>');
    // A past season shows its official final standings, which its weekly game results don't always add up to.
    if (!ARCHIVE) drawRankChart(document.getElementById('rank-chart'), weeklyRanks(league, results));
  }

  // One league's table after a given week, by the standings rule at that point in the season:
  // overall win % (in-league + cross-league), then PF (each week's score, byes included).
  function standingsThrough(league, results, w, teams = league.teams) {
    return teams.map((t) => {
      const own = (results.get(t.id) || []).filter((r) => r.week <= w);
      const inLeague = own.filter((r) => r.result);
      const cross = (t.crossGames || []).filter((g) => g.week <= w);
      const games = inLeague.concat(cross);
      const tally = (list) => {
        const wins = list.filter((g) => g.result === 'W').length;
        const ties = list.filter((g) => g.result === 'T').length;
        return { wins, losses: list.length - wins - ties, ties };
      };
      const record = tally(games);
      const pf = own.filter((r) => r.result || r.bye).reduce((s, r) => s + r.pf, 0);
      return {
        id: t.id, pct: games.length ? (record.wins + record.ties / 2) / games.length : 0, pf,
        record, inLeague: tally(inLeague), cross: tally(cross),
      };
    }).sort((a, b) => b.pct - a.pct || b.pf - a.pf);
  }

  // Each team's rank and record after every completed week.
  function weeklyRanks(league, results) {
    const weeks = [];
    for (let w = 1; w < league.currentWeek; w++) weeks.push(w);
    const teams = league.teams.slice().sort((a, b) => a.id - b.id); // color follows the team, not its rank
    const ranks = new Map(teams.map((t) => [t.id, []]));
    const records = new Map(teams.map((t) => [t.id, []]));
    for (const w of weeks) {
      standingsThrough(league, results, w, teams).forEach((row, i) => {
        ranks.get(row.id).push(i + 1);
        records.get(row.id).push(row.record);
      });
    }
    return { weeks, teams, ranks, records };
  }

  // Validated for the panel surface; 9 hues, so end labels and hover highlight back up the color.
  const RANK_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#2f9a2f', '#9085e9', '#e66767', '#1ca2c2'];

  function drawRankChart(root, { weeks, teams, ranks }) {
    if (!weeks.length) { root.remove(); return; }
    const color = (i) => RANK_COLORS[i % RANK_COLORS.length];
    const lastRank = (t) => ranks.get(t.id)[weeks.length - 1];
    root.innerHTML = `
      <div class="panel-head"><h3>Rank by week</h3><span class="muted rc-sub">After each completed week, by overall record, then PF</span></div>
      <div class="rc-plot"><div class="rc-svg"></div><div class="rc-tip" hidden></div></div>
      <p class="rc-note" hidden></p>
      <details class="rc-table">
        <summary>View as table</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>Team</th>${weeks.map((w) => `<th class="c-num">Wk ${w}</th>`).join('')}</tr></thead>
          <tbody>${teams.slice().sort((a, b) => lastRank(a) - lastRank(b)).map((t) => `
            <tr><td>${esc(t.name)}</td>${ranks.get(t.id).map((r) => `<td class="c-num">${r}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table></div>
      </details>`;

    const plot = root.querySelector('.rc-plot');
    const holder = root.querySelector('.rc-svg');
    const tip = root.querySelector('.rc-tip');
    const note = root.querySelector('.rc-note');
    let pinned = null;

    const emphasize = (id) => {
      const active = id != null ? id : pinned;
      root.querySelectorAll('[data-line]').forEach((g) => {
        g.classList.toggle('dim', active != null && Number(g.dataset.line) !== active);
        g.classList.toggle('on', Number(g.dataset.line) === active);
        const label = g.querySelector('.rc-label');
        if (label) label.setAttribute('aria-pressed', Number(g.dataset.line) === pinned);
      });
    };

    const lineMarks = (t, ti, x, y) => {
      const rs = ranks.get(t.id);
      let d = `M${x(0)} ${y(rs[0])}`;
      for (let i = 1; i < rs.length; i++) {
        const mid = (x(i - 1) + x(i)) / 2;
        d += ` C${mid} ${y(rs[i - 1])} ${mid} ${y(rs[i])} ${x(i)} ${y(rs[i])}`;
      }
      return `
        <path class="rc-line" d="${d}" stroke="${color(ti)}"/>
        ${rs.map((r, i) => `<circle cx="${x(i)}" cy="${y(r)}" r="4" fill="${color(ti)}"/>`).join('')}
        <path class="rc-hit" d="${d}"/>`;
    };

    // Owner name at the end of a line; `place` positions the group, so it can move on phones.
    const ownerLabel = (t, width, rowH, place) => `
      <g class="rc-label" tabindex="0" role="button" aria-label="Highlight ${esc(t.name)}, ${esc(t.owner)}" ${place}>
        <title>${esc(t.name)}</title>
        <rect x="-4" y="${-rowH / 2}" width="${width}" height="${rowH}" fill="transparent"/>
        <text class="rc-end" y="4">${esc(t.owner)}</text>
      </g>`;

    // Hovering a line or name highlights it; click or Enter/Space on a name keeps it highlighted.
    const wireHighlights = () => {
      root.querySelectorAll('[data-line]').forEach((g) => {
        const id = Number(g.dataset.line);
        const hit = g.querySelector('.rc-hit');
        if (hit) {
          hit.addEventListener('pointerenter', () => emphasize(id));
          hit.addEventListener('pointerleave', () => emphasize(null));
        }
        const label = g.querySelector('.rc-label');
        if (!label) return;
        const togglePin = () => { pinned = pinned === id ? null : id; emphasize(null); };
        label.addEventListener('pointerenter', () => emphasize(id));
        label.addEventListener('pointerleave', () => emphasize(null));
        label.addEventListener('focus', () => emphasize(id));
        label.addEventListener('blur', () => emphasize(null));
        label.addEventListener('click', togglePin);
        label.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(); }
        });
      });
    };

    // Shows the most recent weeks (6 on desktop, 3 on phones) and scrolls for the rest. Rank numbers
    // and owner names stay put while the lines move between them; the names re-order to match the
    // right-most visible week.
    const drawChart = (W) => {
      const small = W < 520;
      const visible = small ? 3 : 6;
      const pad = { t: 14, b: 30 };
      const rowH = small ? 28 : 34;
      const axisW = small ? 24 : 28;
      const labelW = small ? 66 : 84;
      const side = 18; // room for the first and last week labels
      const n = weeks.length;
      const H = pad.t + rowH * (teams.length - 1) + pad.b;
      const y = (r) => pad.t + (r - 1) * rowH;
      const vw = W - axisW - labelW;
      const span = Math.min(n - 1, visible - 1);
      const step = span ? (vw - side * 2) / span : 0;
      const x = (i) => (n > 1 ? side + i * step : vw / 2);
      const innerW = n > 1 ? side * 2 + (n - 1) * step : vw;
      const place = (r) => `translate(4px, ${y(r)}px)`;

      holder.innerHTML = `
        <div class="rc-chart ${small ? '' : 'rc-mouse'}">
          <svg width="${axisW}" height="${H}" aria-hidden="true">
            ${teams.map((_, i) => `<text class="rc-axis" x="${axisW - 6}" y="${y(i + 1) + 4}" text-anchor="end">${i + 1}</text>`).join('')}
          </svg>
          <div class="rc-scroll" tabindex="0" role="group" aria-label="Rank chart. Scroll sideways for other weeks. The same values are in the table below.">
            <div class="rc-inner" style="width:${innerW}px">
              <svg width="${innerW}" height="${H}" aria-hidden="true">
                ${teams.map((_, i) => `<line class="rc-grid" x1="0" x2="${innerW}" y1="${y(i + 1)}" y2="${y(i + 1)}"/>`).join('')}
                ${weeks.map((w, i) => `<text class="rc-axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">Wk ${w}</text>`).join('')}
                <line class="rc-cross" x1="0" x2="0" y1="${pad.t - 6}" y2="${H - pad.b + 6}" visibility="hidden"/>
                ${teams.map((t, ti) => `<g data-line="${t.id}">${lineMarks(t, ti, x, y)}</g>`).join('')}
              </svg>
              ${weeks.map((_, i) => (i >= span ? `<span class="rc-snap" style="left:${x(i)}px;width:${side}px"></span>` : '')).join('')}
            </div>
          </div>
          <svg class="rc-names" width="${labelW}" height="${H}">
            ${teams.map((t) => `<g data-line="${t.id}">${ownerLabel(t, labelW, rowH, `style="transform:${place(ranks.get(t.id)[n - 1])}"`)}</g>`).join('')}
          </svg>
        </div>`;

      const scroller = holder.querySelector('.rc-scroll');
      const showWeek = () => {
        if (!scroller.isConnected) return; // chart was redrawn (e.g. phone rotated) before this frame ran
        const end = step ? Math.max(span, Math.min(n - 1, Math.round((scroller.scrollLeft + vw - side * 2) / step))) : n - 1;
        teams.forEach((t) => {
          holder.querySelector(`.rc-names [data-line="${t.id}"] .rc-label`).style.transform = place(ranks.get(t.id)[end]);
        });
        const range = span ? `Weeks ${weeks[end - span]}–${weeks[end]}` : `Week ${weeks[end]}`;
        const verb = small ? 'Swipe' : 'Scroll';
        const hint = n <= visible ? '' : end === n - 1 ? ` · ${verb} for earlier weeks` : end === span ? ` · ${verb} for later weeks` : ` · ${verb} for more weeks`;
        note.textContent = range + hint;
      };
      note.hidden = !small && n <= visible; // desktop only needs the caption when weeks are off screen
      const svg = scroller.querySelector('svg');
      const cross = svg.querySelector('.rc-cross');
      const hideTip = () => {
        cross.setAttribute('visibility', 'hidden');
        tip.hidden = true;
      };
      scroller.addEventListener('scroll', () => {
        hideTip();
        requestAnimationFrame(showWeek);
      }, { passive: true });
      scroller.scrollLeft = innerW;
      showWeek();

      if (small) return; // on phones a touch on the chart should swipe, not open a tooltip
      // Crosshair and tooltip follow the nearest week.
      svg.addEventListener('pointermove', (e) => {
        const box = svg.getBoundingClientRect();
        const i = step ? Math.max(0, Math.min(n - 1, Math.round((e.clientX - box.left - side) / step))) : 0;
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
        const order = teams.map((t, ti) => ({ t, ti, r: ranks.get(t.id)[i] })).sort((a, b) => a.r - b.r);
        tip.innerHTML = `<b>Week ${weeks[i]}</b>${order.map((o) => `<div><em>${o.r}</em><i style="background:${color(o.ti)}"></i>${esc(o.t.owner)}</div>`).join('')}`;
        tip.hidden = false;
        const px = axisW + x(i) - scroller.scrollLeft;
        const left = px + 14 + tip.offsetWidth > W ? px - tip.offsetWidth - 14 : px + 14;
        tip.style.left = `${holder.offsetLeft + Math.max(0, left)}px`;
      });
      svg.addEventListener('pointerleave', hideTip);
    };

    const draw = () => {
      const W = holder.clientWidth;
      if (!W) return;
      tip.hidden = true;
      drawChart(W);
      wireHighlights();
      emphasize(null);
    };

    draw();
    let lastW = plot.clientWidth;
    new ResizeObserver(() => {
      if (plot.clientWidth !== lastW) { lastW = plot.clientWidth; requestAnimationFrame(draw); }
    }).observe(plot);
  }

  // entries: [{ team, league, results }] already in rank order.
  // opts.showLeague tints each row with its league color (all-league table on Home).
  // Playoff clinches for this season's standings, by league: Z clinched a first-round bye, X clinched a playoff
  // spot, E eliminated. Every team plays 2 games a week through Week 14; the table ranks by win %, then PF.
  // PF can't be known ahead, so a team only clinches when no one else can catch it even with a tie in wins,
  // and is only out when enough teams are already out of reach in wins alone.
  const BYE_SEEDS = 2; // seeds 1 and 2 skip the Wildcard round (since 2025)
  const CLINCH_KEY = { Z: 'Clinched a first-round bye', X: 'Clinched a playoff spot', E: 'Eliminated from playoff contention' };
  function clinchMarks(entries, playoffTeams) {
    const marks = new Map();
    if (ARCHIVE) return marks;
    const byLeague = new Map();
    for (const e of entries) (byLeague.get(e.league.slug) || byLeague.set(e.league.slug, []).get(e.league.slug)).push(e);
    for (const list of byLeague.values()) {
      const spots = playoffTeams || list[0].league.playoffTeams;
      if (!spots || list.length <= spots) continue;
      const teams = list.map((e) => {
        const { wins = 0, losses = 0, ties = 0 } = e.team;
        const pts = wins + ties / 2;
        return { e, pts, max: pts + Math.max(0, LAST_REGULAR_WEEK * 2 - wins - losses - ties) };
      });
      for (const me of teams) {
        const others = teams.filter((o) => o !== me);
        const canCatch = others.filter((o) => o.max >= me.pts).length;
        const ahead = others.filter((o) => o.pts > me.max).length;
        const mark = canCatch < BYE_SEEDS ? 'Z' : canCatch < spots ? 'X' : ahead >= spots ? 'E' : '';
        if (mark) marks.set(me.e.team, mark);
      }
    }
    return marks;
  }
  const clinchTag = (mark) => (mark ? `<b class="clinch clinch-${mark.toLowerCase()}" title="${CLINCH_KEY[mark]}" aria-label="${CLINCH_KEY[mark]}">${mark}</b>` : '');
  function clinchKey() {
    if (ARCHIVE) return '';
    return `<p class="clinch-key">${Object.entries(CLINCH_KEY).map(([m, label]) => `<span>${clinchTag(m)}${label}</span>`).join('')}</p>`;
  }

  function standingsTable(entries, opts) {
    // opts.sort: { key: 'rank'|'pct'|'pf'|'pa', dir: 'desc'|'asc' } makes Rank/Overall/PF/PA headers clickable.
    const { overall, currentWeek, playoffTeams = 0, showLeague = false, sort = null } = opts;
    const sortTh = (key, label, cls, title = '') => {
      if (!sort) return `<th class="${cls}" ${title ? `title="${title}"` : ''}>${label}</th>`;
      const on = sort.key === key;
      const aria = on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th class="${cls} sortable ${on ? 'sorted' : ''}" aria-sort="${aria}">
        <button type="button" data-sort="${key}" title="${title || `Sort by ${label}`}">${label}<i class="arrow ${on ? sort.dir : ''}" aria-hidden="true"></i></button></th>`;
    };
    const cols = overall ? 9 : 7;
    // Last 3 completed weeks: in-league + cross-league = 6 games (bye weeks are 2 cross-league games).
    const firstRecentWeek = currentWeek - 3;
    const split = (w, l, t) => `${w}-${l}${t ? `-${t}` : ''}`;
    const marks = overall ? clinchMarks(entries, showLeague ? 0 : playoffTeams) : new Map();
    const rows = entries.map(({ team: t, league, results, rank }, i) => {
      // Every decided game in order, each week's in streakOrder() (a 1-1 week extends the running streak first).
      const byWeek = new Map();
      for (const g of (results || []).filter((r) => r.result).concat(t.crossGames || [])) {
        (byWeek.get(g.week) || byWeek.set(g.week, []).get(g.week)).push(g);
      }
      const games = [];
      for (const wk of [...byWeek.keys()].sort((a, b) => a - b)) {
        games.push(...streakOrder(byWeek.get(wk), games.length ? games[games.length - 1].result : null, (g) => !g.cross));
      }
      const recent = games.filter((g) => g.week >= firstRecentWeek && g.week < currentWeek);
      const dots = recent.map((r) => {
        const vs = r.opp ? ` vs ${r.opp.name}${r.cross ? ` (${r.oppLeague.displayName})` : ''}` : '';
        return `<i class="dot-r ${r.result}" title="Week ${r.week}${r.cross ? ' cross-league' : ''}: ${r.result} ${f2(r.pf)}–${f2(r.pa)}${esc(vs)}"></i>`;
      }).join('');
      let n = 0;
      for (let k = games.length - 1; k >= 0 && games[k].result === games[games.length - 1].result; k--) n++;
      const streak = n ? `${games[games.length - 1].result}${n}` : '';
      // Points per game: PF over the weeks the team has scored (bye weeks count, since PF includes them).
      const weeksPlayed = new Set(games.map((g) => g.week)).size;
      const line = playoffTeams && i + 1 === playoffTeams && i + 1 < entries.length
        ? `<tr class="playoff-line" aria-hidden="true"><td colspan="${cols}"><div class="pl"><span>Playoff line</span><span>Top ${playoffTeams} in</span></div></td></tr>` : '';
      const rowCls = showLeague ? 'lg-row' : i < playoffTeams ? 'in' : 'out';
      return `
        <tr class="${rowCls}" ${showLeague ? `style="--lc:var(--${league.theme})"` : ''}>
          <td class="c-rank"><span class="rank">${rank || i + 1}</span>${clinchTag(marks.get(t))}</td>
          <td class="c-team">
            <a class="team-cell" href="#/${league.slug}/rosters?team=${t.id}">
              ${teamLogo(t, league)}
              <span><strong>${esc(t.name)}</strong><small>${esc(t.owner)}${champBadges(t)}</small>${showLeague ? `<small class="lg-name">${esc(league.displayName)}</small>` : ''}</span>
            </a>
          </td>
          <td class="c-num c-rec">${record(t)}</td>
          ${overall ? `<td class="c-num hide-sm muted">${split(t.inW, t.inL, t.inT)}</td><td class="c-num hide-sm muted">${split(t.xW, t.xL, t.xT)}</td>` : ''}
          <td class="c-last hide-xs"><span class="dots">${dots}</span><span class="streak ${streak[0] || ''}">${streak}</span></td>
          <td class="c-num" ${t.byePf ? `title="Includes ${f2(t.byePf)} from bye weeks"` : ''}>${f2(t.pf)}</td>
          <td class="c-num hide-sm ${showLeague ? 'hide-md' : ''}">${weeksPlayed ? f2(t.pf / weeksPlayed) : '—'}</td>
          <td class="c-num hide-sm muted" ${t.crossPa ? `title="In-league ${f2(t.pa - t.crossPa)} + cross-league ${f2(t.crossPa)}"` : ''}>${f2(t.pa)}</td>
        </tr>${line}`;
    }).join('');
    return `
      <div class="panel st-panel ${standingsExpanded ? 'st-expanded' : ''}">
        <button class="toggle st-expand" type="button" aria-expanded="${standingsExpanded}">${standingsExpanded ? 'Show fewer columns' : 'Show all columns'}</button>
        ${sort ? '<p class="pw-sort">Table sortable by Rank, Overall Record, PF, and PA</p>' : ''}
        <p class="st-hint">Swipe the table sideways to see every column</p>
        <div class="table-wrap">
          <table class="standings">
            <thead><tr>
              ${sortTh('rank', 'Rank', 'c-rank', 'Sort by standings (record, then PF)')}<th>Team</th>${sortTh('pct', overall ? 'Overall' : 'Record', 'c-num', 'Sort by record')}
              ${overall ? '<th class="c-num hide-sm" title="In-league record">League</th><th class="c-num hide-sm" title="Cross-league record">Cross</th>' : ''}
              <th class="c-last hide-xs" title="In-league and cross-league games from the last 3 completed weeks">${overall ? 'Last 6' : 'Last 3'}</th>${sortTh('pf', 'PF', 'c-num')}
              <th class="c-num hide-sm ${showLeague ? 'hide-md' : ''}" title="Points per game: average weekly score">PPG</th>${sortTh('pa', 'PA', 'c-num hide-sm')}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${overall ? clinchKey() : ''}
      </div>
      <p class="fineprint">${overall
        ? 'Ranked by overall record (in-league + cross-league win %), then points for. Last 6 covers the last 3 completed weeks, in-league and cross-league. PF includes bye-week scores and PA includes cross-league opponents, so neither will match ESPN.'
        : 'Cross-league results are unavailable right now, so this shows in-league records only. PF includes bye-week scores.'} Tap a team to see its roster.</p>`;
  }

  // ---------- power rankings ----------
  // ---------- transactions ----------
  const TX_PAGE = 20;
  let txFile = null;
  function transactionsFile() {
    if (!txFile || Date.now() - txFile.t > 300000) {
      txFile = {
        t: Date.now(),
        p: fetch('data/transactions.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      };
    }
    return txFile.p;
  }

  // The saved season so far, plus anything newer from ESPN. Without the file, the whole season comes live.
  async function leagueTransactions(cfg) {
    const saved = await transactionsFile();
    const file = saved && saved.season === SEASON ? saved : null;
    const rows = file ? (file.leagues[cfg.slug] || []).slice() : [];
    const players = file ? Object.assign({}, file.players) : {};
    let incomplete = false;
    try {
      const period = await ESPN.getCurrentPeriod(cfg.id);
      const periods = [];
      for (let p = file ? Math.min(file.lastPeriod, period) : 1; p <= period; p++) periods.push(p);
      const raw = (await Promise.all(periods.map((p) => ESPN.getRawTransactions(cfg.id, p)))).flat();
      const known = new Set(rows.map((r) => r.id));
      const fresh = ESPN.parseTransactions(raw).filter((r) => !known.has(r.id));
      for (const r of fresh) {
        if (r.type === 'trade') {
          r.teams.forEach((t) => { r.sides[t] = []; });
          r.pending = true;
        }
      }
      rows.push(...fresh);
      const ids = fresh.flatMap((r) => (r.type === 'trade' ? r.drops.map((d) => d[1]) : [...r.adds, ...r.drops]));
      const unknown = [...new Set(ids)].filter((id) => !players[id]);
      if (unknown.length) Object.assign(players, await ESPN.getPlayerInfo(unknown));
    } catch (err) {
      if (!file) throw err;
      console.warn('Latest transactions unavailable; showing saved ones', err);
      incomplete = true;
    }
    rows.sort((a, b) => b.date - a.date);
    return { rows, players, incomplete };
  }

  const TX_DATE = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  });
  const TX_LABEL = { add: 'Added', drop: 'Dropped', waiver: 'Waiver', trade: 'Trade' };

  function txPlayer(id, players, sign) {
    const p = players[id];
    const dst = id < 0;
    const img = dst
      ? (p && p[2] ? ESPN.nflLogo(p[2]) : '')
      : `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${id}.png&w=96&h=70`;
    return `
      <div class="tx-player">
        <span class="tx-sign ${sign === '+' ? 'in' : 'out'}" aria-label="${sign === '+' ? 'Added' : 'Dropped'}">${sign === '+' ? '+' : '&minus;'}</span>
        ${img ? `<img class="${dst ? 'dst' : ''}" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<i class="tx-noimg"></i>'}
        <span class="tx-name"><b>${esc(p ? p[0] : `Player ${id}`)}</b>${p ? `<small>${esc(p[1])} · ${esc(p[2])}</small>` : ''}</span>
      </div>`;
  }

  function txRow(row, cfg, teamById, players) {
    const teamHead = (id) => {
      const t = teamById.get(Number(id));
      return `
        <a class="tx-team" href="#/${cfg.slug}/rosters?team=${id}">
          ${t ? teamLogo(t, cfg) : ''}
          <span><strong>${esc(t ? t.name : `Team ${id}`)}</strong><small>${esc(t ? t.owner : '')}</small></span>
        </a>`;
    };
    const head = `
      <div class="tx-meta">
        <span class="tx-type tx-${row.type}">${TX_LABEL[row.type]}</span>
        <time datetime="${new Date(row.date).toISOString()}">${esc(TX_DATE.format(new Date(row.date)))} ET</time>
      </div>`;
    if (row.type === 'trade') {
      const sides = Object.entries(row.sides);
      return `
        <li class="tx tx-is-trade">
          ${head}
          <div class="tx-sides">
            ${sides.map(([id, list]) => `
              <div class="tx-side">
                ${teamHead(id)}
                <div class="tx-moves">
                  ${list.map((p) => txPlayer(p, players, '+')).join('')}
                  ${row.drops.filter((d) => String(d[0]) === id).map((d) => txPlayer(d[1], players, '-')).join('')}
                </div>
              </div>`).join('')}
          </div>
          ${row.pending ? '<p class="muted tx-none">Players in this trade appear after the next site update.</p>' : ''}
          ${row.seeDate ? `<p class="muted tx-none">ESPN doesn't list this trade's players separately. They may be included in the ${esc(new Date(row.seeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }))} trade.</p>` : ''}
          ${!row.pending && !row.seeDate && !sides.some(([, list]) => list.length) ? '<p class="muted tx-none">ESPN doesn\'t list the players in this trade.</p>' : ''}
        </li>`;
    }
    return `
      <li class="tx">
        ${head}
        ${teamHead(row.team)}
        <div class="tx-moves">
          ${row.adds.map((p) => txPlayer(p, players, '+')).join('')}
          ${row.drops.map((p) => txPlayer(p, players, '-')).join('')}
        </div>
      </li>`;
  }

  async function renderTransactions(cfg, teams, body, token) {
    const { rows, players, incomplete } = await leagueTransactions(cfg);
    if (token !== renderToken) return;
    if (!rows.length) {
      body().innerHTML = '<div class="state">No transactions yet this season.</div>';
      return;
    }
    const teamById = new Map(teams.map((t) => [t.id, t]));
    let shown = 0;
    body().innerHTML = `
      <div class="panel">
        <ul class="tx-list" id="tx-list"></ul>
      </div>
      <div class="tx-foot">
        <p class="muted" id="tx-count" aria-live="polite"></p>
        <button class="btn tx-more" type="button" id="tx-more">Load more</button>
      </div>
      ${incomplete ? '<p class="fineprint">Couldn\'t reach ESPN just now, so the newest moves may be missing.</p>' : ''}`;
    const list = body().querySelector('#tx-list');
    const more = body().querySelector('#tx-more');
    const count = body().querySelector('#tx-count');
    const showMore = () => {
      const next = rows.slice(shown, shown + TX_PAGE);
      list.insertAdjacentHTML('beforeend', next.map((r) => txRow(r, cfg, teamById, players)).join(''));
      shown += next.length;
      count.textContent = `Showing ${shown} of ${rows.length} transactions`;
      more.hidden = shown >= rows.length;
    };
    more.addEventListener('click', showMore);
    showMore();
  }

  // ---------- draft board ----------
  // Saved once after the draft by tools/build-draft-boards.js.
  let draftFile = null;
  function draftBoards() {
    if (!draftFile) {
      // Bump the ?v= after rebuilding the file; the browser can otherwise keep it as long as it likes.
      draftFile = fetch(`${DATA}draft-boards.json?v=2`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    return draftFile;
  }

  // "Jahmyr Gibbs" -> "J. Gibbs", "Texans D/ST" -> "Texans"; names starting with initials stay as they are.
  const shortName = (p) => {
    if (p.pos === 'D/ST') return p.name.replace(' D/ST', '');
    const [first, ...rest] = p.name.split(' ');
    return /\./.test(first) || !rest.length ? p.name : `${first[0]}. ${rest.join(' ')}`;
  };

  async function renderDraftBoard(league, body, token) {
    const file = await draftBoards();
    if (token !== renderToken) return;
    const board = file && file.season === SEASON && file.leagues[league.slug];
    if (!board) {
      body().innerHTML = '<div class="state"><strong>This draft board isn\'t available.</strong></div>';
      return;
    }
    const rounds = Array.from({ length: board.rounds }, (_, i) => i + 1);
    const cell = (p) => {
      if (!p) return '<td class="dp dp-empty"></td>';
      const dst = p.pos === 'D/ST';
      const img = dst ? ESPN.nflLogo(p.team) : `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${p.id}.png&w=96&h=70`;
      return `
        <td class="dp s-${p.pos.replace('/', '')}" title="${esc(p.name)}">
          <b>${esc(shortName(p))}</b>
          <small>${esc(p.pos)} · ${esc(p.team)}</small>
          <img class="${dst ? 'dp-logo' : ''}" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        </td>`;
    };
    body().innerHTML = `
      <div class="panel">
        ${board.offline ? `<p class="draft-note"><b>Roster view.</b> This board shows each team’s draft picks, not the order they were made in. The ${SEASON} draft was held offline, and the original board wasn’t kept.</p>` : ''}
        <p class="draft-hint">Swipe sideways to see every team</p>
        <div class="table-wrap">
          <table class="draft">
            <thead><tr>
              <th class="dr-rd">Rd</th>
              ${board.columns.map((id) => {
                const t = board.teams[id];
                return `<th><a href="#/${league.slug}/rosters?team=${id}" title="${esc(t ? t.name : '')}">${t ? teamLogo({ ...t, id: Number(id) }, league) : ''}<span>${esc(t ? t.owner : '')}</span></a></th>`;
              }).join('')}
            </tr></thead>
            <tbody>${rounds.map((r) => `
              <tr>
                <th class="dr-rd" scope="row">${r}</th>
                ${board.columns.map((id) => cell((board.picks[id] || [])[r - 1])).join('')}
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <p class="fineprint">${!ARCHIVE ? 'Draft results by round, with teams in the same order as the league’s draft board.'
        : board.offline ? `Picks are ESPN’s record of the offline draft, typed in afterward, so the rounds and the team order may not match how the draft went.`
        : `Draft results by round from ESPN, with teams in round 1 draft order. It was a snake draft, so the order reversed every round.`}</p>`;
  }

  // Results are calculated once a week by tools/run-power-rankings.js; the page only reads the saved file.
  let lockedCache = null;
  function lockedRankings() {
    if (lockedCache && Date.now() - lockedCache.t < 300000) return lockedCache.p;
    const p = fetch(`${DATA}power-rankings.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d && d.season === SEASON ? d : null))
      .catch(() => null);
    lockedCache = { t: Date.now(), p };
    return p;
  }

  const BLANK_ODDS = { playoffs: 0, bye: 0, title: 0, grand: 0 };
  function oddsPct(v) {
    const n = v * 100;
    if (n >= 99.5) return '>99%';
    if (n < 0.5) return '<1%';
    return `${Math.round(n)}%`;
  }
  function lockedStatus({ week, calculatedAt }, currentWeek) {
    const asOf = new Date(calculatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    return week < currentWeek
      ? `From Week ${week}, calculated ${asOf}. This week's update is on its way.`
      : `Locked for Week ${week}. Calculated ${asOf}; next update after this week's games are final.`;
  }

  async function renderPowerRankings(league, body, token) {
    const locked = await lockedRankings();
    if (token !== renderToken) return;
    if (!locked) {
      body().innerHTML = '<div class="state"><strong>Power Rankings aren\'t available yet.</strong><span>They\'re calculated once a week, after ESPN finalizes the previous week.</span></div>';
      return;
    }
    const { odds, sims } = locked;
    const status = lockedStatus(locked, league.currentWeek);
    const pct = oddsPct;
    const rows = league.teams.map((team, standing) => ({ team, standing, o: odds[`${league.slug}:${team.id}`] || BLANK_ODDS }))
      .sort((a, b) => b.o.title - a.o.title || b.o.playoffs - a.o.playoffs || b.o.bye - a.o.bye || a.standing - b.standing);
    body().innerHTML = `
      <p class="pw-status">${esc(status)}</p>
      <div class="panel">
        <p class="pw-hint">Swipe the table sideways to see every column</p>
        <div class="table-wrap">
          <table class="standings power">
            <thead><tr>
              <th class="c-rank">Rank</th><th>Team</th><th class="c-num">Overall</th>
              <th class="c-num">Playoffs</th><th class="c-num">Round 1 bye</th><th class="c-num">Win league</th>
            </tr></thead>
            <tbody>${rows.map(({ team: t, o }, i) => `
              <tr class="in">
                <td class="c-rank"><span class="rank">${i + 1}</span></td>
                <td class="c-team">
                  <a class="team-cell" href="#/${league.slug}/rosters?team=${t.id}">
                    ${teamLogo(t, league)}
                    <span><strong>${esc(t.name)}</strong><small>${esc(t.owner)}${champBadges(t)}</small></span>
                  </a>
                </td>
                <td class="c-num c-rec">${record(t)}</td>
                <td class="c-num">${pct(o.playoffs)}</td>
                <td class="c-num">${pct(o.bye)}</td>
                <td class="c-num pw-title">${pct(o.title)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <p class="fineprint">Ranked by chance to win the league. Estimates from ${sims.toLocaleString('en-US')} simulations of the rest of the season, using ESPN's rest-of-season roster projections, each team's scoring so far, the remaining in-league and cross-league schedule, and the playoff format: top 5 make it, top 2 get a round 1 bye.</p>`;
  }

  // ---------- playoff bracket ----------
  const LAST_REGULAR_WEEK = 14;
  const PLAYOFF_ROUNDS = { round1: 15, round2: 16, cup: 17 };

  // Each league's order by overall record, then PF, counting regular-season weeks only.
  function playoffSeeds(entries) {
    const final = (r) => r.week <= LAST_REGULAR_WEEK && (r.bye || r.result);
    return LEAGUES.map((cfg) => {
      const teams = entries.filter((e) => e.league.slug === cfg.slug).map((e) => {
        const own = (e.results || []).filter(final);
        const games = own.filter((r) => r.result).concat((e.team.crossGames || []).filter(final));
        const wins = games.filter((g) => g.result === 'W').length + games.filter((g) => g.result === 'T').length / 2;
        return { ...e, pct: games.length ? wins / games.length : 0, seasonPf: own.reduce((sum, r) => sum + r.pf, 0), games: games.length };
      }).sort((a, b) => b.pct - a.pct || b.seasonPf - a.seasonPf);
      teams.forEach((t, i) => { t.seed = i + 1; });
      return { cfg, teams };
    });
  }

  // ESPN schedules no playoff games, so a team's score comes from its roster for that week.
  async function playoffScores(leagues, week) {
    const rosters = await Promise.all(leagues.map((l) => ESPN.getRosters(l, week)));
    const scores = new Map();
    leagues.forEach((l, i) => {
      for (const [id, { starters, bench }] of rosters[i].byTeam) {
        const points = (list) => list.reduce((sum, p) => sum + (p.id ? p.points : 0), 0);
        const open = starters.some((p) => p.id && (p.game.state === 'pre' || p.game.state === 'live'));
        scores.set(`${l.slug}:${id}`, { score: points(starters), bench: points(bench.filter((p) => p.slotId === 20)), open, started: starters.some((p) => p.points) });
      }
    });
    return scores;
  }

  // Scores for each playoff round that has reached its week.
  async function bracketScores(week) {
    const leagues = week >= PLAYOFF_ROUNDS.round1 ? await loadAllLeagues() : null;
    const roundWeeks = Object.values(PLAYOFF_ROUNDS).filter((w) => w <= week);
    const scoresByWeek = new Map(await Promise.all(roundWeeks.map(async (w) => [w, await playoffScores(leagues, w)])));
    const scoreIn = (w) => (t) => {
      const scores = scoresByWeek.get(w);
      return scores ? scores.get(`${t.league.slug}:${t.team.id}`) : null;
    };
    return { scoresByWeek, scoreIn };
  }

  function refreshWhileLive(scoresByWeek, token, redraw) {
    const inProgress = [...scoresByWeek.values()].some((scores) => [...scores.values()].some((s) => s.open && s.started));
    if (!inProgress || !LIVE_REFRESH_MS) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async function tick() {
      if (token !== renderToken) return;
      if (document.hidden) { refreshTimer = setTimeout(tick, LIVE_REFRESH_MS); return; }
      try {
        await redraw();
      } catch (err) {
        console.error(err);
        refreshTimer = setTimeout(tick, LIVE_REFRESH_MS);
      }
    }, LIVE_REFRESH_MS);
  }

  // Top score wins. An exact tie goes to bench points, then the higher seed.
  function pickWinner(group, scoreOf) {
    const row = group.map((t) => ({ t, s: scoreOf(t) }));
    if (row.some(({ s }) => !s || s.open)) return null;
    return row.sort((a, b) => b.s.score - a.s.score || b.s.bench - a.s.bench || a.t.seed - b.t.seed
      || b.t.pct - a.t.pct || b.t.seasonPf - a.t.seasonPf)[0].t;
  }

  function bracketTeam(t, { odds, score, won, lost }) {
    return `
      <a class="team-cell pb-team ${won ? 'won' : ''} ${lost ? 'lost' : ''}" href="#/${t.league.slug}/rosters?team=${t.team.id}" style="--lc:var(--${t.league.theme})">
        <i class="pb-seed">${t.seed}</i>
        ${teamLogo(t.team, t.league)}
        <span><strong>${esc(t.team.name)}</strong><small>${esc(t.team.owner)} · ${record(t.team)}</small></span>
        ${score != null ? `<b class="pb-num">${f2(score)}</b>` : odds != null ? `<b class="pb-num pb-odds" title="Chance to win the league">${oddsPct(odds)}</b>` : ''}
      </a>`;
  }

  // The teams that skip Round 1, listed above its games without scores.
  function byeBlock(teams) {
    return `<div class="pb-game pb-bye"><p class="pb-game-title"><span class="pb-game-name">First-round bye</span></p><div class="tb-match">${teams.map((t) => bracketTeam(t, {})).join('')}</div></div>`;
  }

  function bracketGroup(title, week, note, inner) {
    return `
      <div class="pb-round">
        <h4>${esc(title)} <small>Week ${week}</small></h4>
        <div class="pb-group">${inner}</div>
        <p class="pb-note">${esc(note)}</p>
      </div>`;
  }

  async function renderPlayoffBracket(entries, week, body, token) {
    const seeded = playoffSeeds(entries);
    if (!seeded.some(({ teams }) => teams.some((t) => t.games))) {
      body().innerHTML = '<div class="state"><strong>The bracket isn\'t available yet.</strong><span>It fills in once the first week is final.</span></div>';
      return;
    }
    const [locked, { scoresByWeek, scoreIn }] = await Promise.all([lockedRankings(), bracketScores(week)]);
    if (token !== renderToken) return;
    const oddsOf = (t) => (locked ? (locked.odds[`${t.league.slug}:${t.team.id}`] || BLANK_ODDS).title : null);
    const shown = (t, w, winner) => {
      const s = scoreIn(w)(t);
      return {
        odds: week < PLAYOFF_ROUNDS.round1 ? oddsOf(t) : null,
        score: s && (s.started || !s.open) ? s.score : null,
        won: winner === t,
        lost: !!winner && winner !== t,
      };
    };
    const champions = [];
    const cards = seeded.map(({ cfg, teams }) => {
      const top = teams.slice(0, 5);
      const round1 = top.slice(2, 5);
      const r1Winner = pickWinner(round1, scoreIn(PLAYOFF_ROUNDS.round1));
      const round2 = r1Winner ? [top[0], top[1], r1Winner] : top.slice(0, 2);
      const champion = r1Winner ? pickWinner(round2, scoreIn(PLAYOFF_ROUNDS.round2)) : null;
      champions.push({ cfg, champion });
      const out = teams[5];
      return `
        <article class="panel pb-card" style="--lc:var(--${cfg.theme})">
          <h3 class="pb-league"><i class="dot" style="--c:var(--${cfg.theme})"></i>${esc(cfg.name)}</h3>
          <div class="pb-rounds">
            ${bracketGroup('Round 1', PLAYOFF_ROUNDS.round1, 'Top score advances', byeBlock(top.slice(0, 2)) + round1.map((t) => bracketTeam(t, shown(t, PLAYOFF_ROUNDS.round1, r1Winner))).join(''))}
            <i class="pb-arrow" aria-hidden="true"></i>
            ${bracketGroup('Round 2', PLAYOFF_ROUNDS.round2, 'Top score is League Champion', `${round2.map((t) => bracketTeam(t, shown(t, PLAYOFF_ROUNDS.round2, champion))).join('')}${r1Winner ? '' : '<p class="pb-slot">Round 1 winner</p>'}`)}
          </div>
          ${out && week <= LAST_REGULAR_WEEK ? `<p class="pb-out">First team out: <b>${esc(out.team.name)}</b> (${esc(out.team.owner)}, ${record(out.team)})</p>` : ''}
        </article>`;
    }).join('');
    const decided = champions.map((c) => c.champion);
    const grand = decided.every(Boolean) ? pickWinner(decided, scoreIn(PLAYOFF_ROUNDS.cup)) : null;
    const cup = bracketGroup('Champions Cup', PLAYOFF_ROUNDS.cup, 'Top score of the four is Grand Champion', champions.map(({ cfg, champion }) => (champion
      ? bracketTeam(champion, { ...shown(champion, PLAYOFF_ROUNDS.cup, grand), odds: null })
      : `<p class="pb-slot" style="--lc:var(--${cfg.theme})"><i class="dot" style="--c:var(--${cfg.theme})"></i>${esc(cfg.name)} champion</p>`)).join(''));
    body().innerHTML = `
      <p class="pw-status">${week <= LAST_REGULAR_WEEK
        ? `If the season ended today, using standings through ${week > 1 ? `Week ${week - 1}` : 'this week'}.`
        : grand ? 'Final playoff results.' : 'Playoffs are underway.'}</p>
      ${week <= LAST_REGULAR_WEEK && locked ? '<p class="pw-status">Percentages are each team\'s chance to win their league, from the Power Rankings.</p>' : ''}
      <div class="pb-grid">${cards}</div>
      <article class="panel pb-card pb-cup">${cup}</article>
      <p class="fineprint">The top 5 teams in each league make the playoffs, seeded by overall record, then points for. Seeds 1 and 2 skip Round 1. In any round, an exact tie goes to bench points, then the higher seed.</p>`;
    refreshWhileLive(scoresByWeek, token, () => renderPlayoffBracket(entries, week, body, token));
  }

  // ---------- a past season's bracket ----------
  // The league's own playoffs as played, from playoffs.json (tools/build-history.py): each league's Round 1
  // and Round 2, then the placement finals between the leagues.
  // Each season's round notes; 2024 on had four leagues, so its finals are four-team games, one team per league.
  const SEASON_ROUNDS = {
    2023: {
      playoffs: [
        'Round 1', 'Semifinal winners play for the league title, losers for 3rd place',
        'Round 2', 'League champions meet in the Championship; everyone else plays a placement final',
      ],
      toilet: [
        'Round 1', 'The lower score of each semifinal moves on to the Ultimate Loser game',
        'Round 2', 'The lower score of the Ultimate Loser game goes to the Toilet Bowl',
      ],
    },
    2025: {
      playoffs: [
        'Round 1', 'Seeds 3 to 5 play a three-team Wildcard: the top score goes to the Championship, the other two play for 4th',
        'Round 2', 'Seeds 1 and 2 and the Wildcard winner play for the league title; the top score goes to the Champions Cup',
      ],
      toilet: [
        'Round 1', 'Seeds 6 to 9 play in pairs: the lower scores meet in the Losers Final, the higher scores play for 6th',
        'Round 2', 'The lower score of each league\u2019s Losers Final goes to the Toilet Bowl Final',
      ],
    },
    2024: {
      playoffs: [
        'Round 1', 'Semifinal winners play for the league title, losers for 3rd place',
        'Round 2', 'League champions go to the Champions Cup; everyone else plays a placement final',
      ],
      toilet: [
        'Round 1', "The higher score of each semifinal plays for 5th place; the lower scores meet in the league's Toilet Bowl",
        'Round 2', "The lower score of each league's Toilet Bowl goes to the Toilet Bowl Final",
      ],
    },
  };
  async function renderSeasonBracket(entries, kind, body, token) {
    const file = await fetch(`${DATA}playoffs.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (token !== renderToken) return;
    if (!file) {
      body().innerHTML = '<div class="state state-error" role="alert"><strong>Couldn\'t load the bracket.</strong></div>';
      return;
    }
    const byOwner = new Map(entries.map((e) => [e.team.owner, e]));
    const games = file.games.filter((g) => g.bracket === kind);
    const indexOf = new Map(file.games.map((g, i) => [g, i]));
    const sinks = (g) => /Losers|Ultimate Loser|Toilet Bowl/.test(g.title); // the lower score moves on
    const place = (g) => (g.title === 'Championship' ? 1 : g.title === 'Toilet Bowl' ? 99 : parseInt(g.title, 10) || 50);
    // The team the game picks out: its top score, or its lowest where the lower score moves on.
    const picked = (g) => {
      const order = g.teams.slice().sort((x, y) => (sinks(g) ? x.score - y.score : y.score - x.score));
      return order[0].score === order[1].score ? null : order[0];
    };
    const game = (g, label = g.title) => {
      const pick = picked(g);
      const four = g.teams.length > 2; // a four-team final lists its teams by score
      const list = four ? g.teams.slice().sort((x, y) => y.score - x.score) : g.teams;
      const sides = list.map((s) => bracketTeam({ ...byOwner.get(s.owner), seed: s.seed }, { score: s.score, won: pick === s, lost: !!pick && pick !== s }));
      // Title games stand out: each league's championship and the Grand Championship in gold, each league's
      // Ultimate Loser game and the Toilet Bowl in brown.
      const cfg = g.league && LEAGUES.find((l) => l.slug === g.league);
      const champ = g.title === 'Championship';
      const title = champ || g.title === 'Ultimate Loser' || g.title === 'Toilet Bowl' || g.title === 'Losers Final';
      const icon = cfg ? (champ ? cfg.badge : cfg.logo) : `assets/img/champs/${champ ? 'grand-champion' : 'ultimate-loser'}.png`;
      const name = g.name || (cfg ? `${cfg.name} ${g.title}` : champ ? 'Grand Championship' : 'Toilet Bowl');
      const head = title ? `<img src="${icon}" alt="" width="22" height="22">${esc(name)}` : esc(label);
      const cls = title ? `pb-champ ${champ ? '' : 'pb-loser'} ${cfg ? '' : 'pb-grand'}` : '';
      const view = `<a class="pb-view" href="${playoffGameLink(g, indexOf.get(g))}" aria-label="View the ${esc(title ? name : `${cfg ? `${cfg.name} ` : ''}${label}`)} matchup">View matchup ›</a>`;
      return `<div class="pb-game ${cls}"><p class="pb-game-title"><span class="pb-game-name">${head}</span>${view}</p><div class="tb-match ${sinks(g) ? 'tb-low' : ''} ${four ? 'tb-four' : ''}">${sides.join(four ? '' : '<span class="tb-vs">vs</span>')}</div></div>`;
    };
    const [r1, n1, r2, n2] = (SEASON_ROUNDS[SEASON] || SEASON_ROUNDS[2023])[kind];
    const cards = LEAGUES.map((cfg) => {
      const mine = games.filter((g) => g.league === cfg.slug);
      const round = (week) => mine.filter((g) => g.week === week).map((g) => game(g)).join('');
      // Teams that start in Round 2 had a first-round bye.
      const inRound1 = new Set(mine.filter((g) => g.week === 15).flatMap((g) => g.teams.map((s) => s.owner)));
      const byes = mine.filter((g) => g.week === 16).flatMap((g) => g.teams)
        .filter((s) => !inRound1.has(s.owner) && byOwner.has(s.owner)).sort((a, b) => a.seed - b.seed);
      const byeList = byes.length ? byeBlock(byes.map((s) => ({ ...byOwner.get(s.owner), seed: s.seed }))) : '';
      return `
        <article class="panel pb-card" style="--lc:var(--${cfg.theme})">
          <h3 class="pb-league"><i class="dot" style="--c:var(--${cfg.theme})"></i>${esc(cfg.name)}</h3>
          <div class="pb-rounds">
            ${bracketGroup(r1, 15, n1, byeList + round(15))}
            <i class="pb-arrow" aria-hidden="true"></i>
            ${bracketGroup(r2, 16, n2, round(16))}
          </div>
        </article>`;
    }).join('');
    // The headline game leads: the Championship, then 3rd, 5th...; the Toilet Bowl, then 15th, 13th...
    const finals = games.filter((g) => !g.league).sort((a, b) => (kind === 'toilet' ? place(b) - place(a) : place(a) - place(b)));
    const top = finals.find((g) => g.title === (kind === 'toilet' ? 'Toilet Bowl' : 'Championship'));
    const who = byOwner.get(picked(top).owner).team;
    const topName = top.name || (kind === 'toilet' ? 'Toilet Bowl' : 'Championship');
    const many = top.teams.length > 2;
    body().innerHTML = `
      <p class="pw-status">Final results. ${kind === 'toilet' ? 'The Ultimate Loser' : 'The Grand Champion'} is ${esc(who.name)} (${esc(who.owner)}).</p>
      <div class="pb-grid">${cards}</div>
      <article class="panel pb-card pb-cup pb-finals">
        ${bracketGroup(`${topName} and placement finals`, 17,
          kind === 'toilet'
            ? (many ? `Lowest score of the four in the ${topName} is the Ultimate Loser; each placement final ranks its four teams by score` : `The lower score of the ${topName} is the Ultimate Loser`)
            : (many ? `Top score of the four in the ${topName} is Grand Champion; each placement final ranks its four teams by score` : `The ${topName} winner is Grand Champion`),
          finals.map((g) => game(g, g.week === 17 ? g.title : `${g.title} · Week ${g.week}`)).join(''))}
      </article>
      <p class="fineprint">The ${SEASON} bracket as the league played it. Seeds are each team's place in its league's regular-season standings. ${kind === 'toilet'
        ? 'Red, or brown in the title games, marks the team sent on by its lower score; green marks the top score of a placement game.'
        : 'Green marks each game\'s winner.'}</p>`;
  }

  // ---------- toilet bowl ----------
  // Lowest score advances. An exact tie sends on the team with fewer bench points, then the lower seed.
  function pickLoser(group, scoreOf) {
    const row = group.map((t) => ({ t, s: scoreOf(t) }));
    if (row.some(({ s }) => !s || s.open)) return null;
    return row.sort((a, b) => a.s.score - b.s.score || a.s.bench - b.s.bench || b.t.seed - a.t.seed
      || a.t.pct - b.t.pct || a.t.seasonPf - b.t.seasonPf)[0].t;
  }

  async function renderToiletBowl(entries, week, body, token) {
    const seeded = playoffSeeds(entries);
    if (!seeded.some(({ teams }) => teams.some((t) => t.games))) {
      body().innerHTML = '<div class="state"><strong>The bracket isn\'t available yet.</strong><span>It fills in once the first week is final.</span></div>';
      return;
    }
    const { scoresByWeek, scoreIn } = await bracketScores(week);
    if (token !== renderToken) return;
    const { round1, round2, cup } = PLAYOFF_ROUNDS;
    const shown = (t, w, loser) => {
      const s = scoreIn(w)(t);
      return { score: s && (s.started || !s.open) ? s.score : null, won: loser === t, lost: !!loser && loser !== t };
    };
    const matchup = (pair, w, loser) => `<div class="tb-match">${pair.map((t) => bracketTeam(t, shown(t, w, loser))).join('<span class="tb-vs">vs</span>')}</div>`;
    const leagueLosers = [];
    const cards = seeded.map(({ cfg, teams }) => {
      const [six, seven, eight, nine] = teams.slice(5, 9);
      const first = [six, nine];
      const second = [seven, eight];
      const firstLoser = pickLoser(first, scoreIn(round1));
      const secondLoser = pickLoser(second, scoreIn(round1));
      const leagueLoser = firstLoser && secondLoser ? pickLoser([firstLoser, secondLoser], scoreIn(round2)) : null;
      leagueLosers.push({ cfg, loser: leagueLoser });
      const slot = (t, label) => (t ? bracketTeam(t, shown(t, round2, leagueLoser)) : `<p class="pb-slot">${label}</p>`);
      return `
        <article class="panel pb-card" style="--lc:var(--${cfg.theme})">
          <h3 class="pb-league"><i class="dot" style="--c:var(--${cfg.theme})"></i>${esc(cfg.name)}</h3>
          <div class="pb-rounds">
            ${bracketGroup('Round 1', round1, 'Loser of each matchup advances', matchup(first, round1, firstLoser) + matchup(second, round1, secondLoser))}
            <i class="pb-arrow" aria-hidden="true"></i>
            ${bracketGroup('Round 2', round2, 'Loser goes to the final', `<div class="tb-match">${slot(firstLoser, 'Loser of 6 vs. 9')}<span class="tb-vs">vs</span>${slot(secondLoser, 'Loser of 7 vs. 8')}</div>`)}
          </div>
        </article>`;
    }).join('');
    const finalists = leagueLosers.map((l) => l.loser);
    const ultimate = finalists.every(Boolean) ? pickLoser(finalists, scoreIn(cup)) : null;
    const final = bracketGroup('Toilet Bowl Final', cup, 'Lowest score of the four is the Ultimate Loser', leagueLosers.map(({ cfg, loser }) => (loser
      ? bracketTeam(loser, shown(loser, cup, ultimate))
      : `<p class="pb-slot"><i class="dot" style="--c:var(--${cfg.theme})"></i>${esc(cfg.name)} loser</p>`)).join(''));
    body().innerHTML = `
      <p class="pw-status">${week <= LAST_REGULAR_WEEK
        ? `If the season ended today, using standings through ${week > 1 ? `Week ${week - 1}` : 'this week'}.`
        : ultimate ? `Final results. The Ultimate Loser is ${esc(ultimate.team.name)} (${esc(ultimate.team.owner)}).` : 'The Toilet Bowl is underway.'}</p>
      <div class="tb">
        <div class="pb-grid">${cards}</div>
        <article class="panel pb-card pb-cup">${final}</article>
      </div>
      <p class="fineprint">Seeds 6 to 9 in each league play for last, seeded by overall record, then points for. The lower score advances in each round. In an exact tie, the team with fewer bench points advances, then the lower seed.</p>`;
    refreshWhileLive(scoresByWeek, token, () => renderToiletBowl(entries, week, body, token));
  }

  // Each team's score against all 35 others, every finished week, compared with its actual record.
  // Strength of schedule is the average all-play win rate of the opponents a team has faced.
  function luckIndex(entries, currentWeek) {
    const final = (r) => r.bye || r.result;
    const weeks = new Map();
    for (const e of entries) {
      for (const r of e.results || []) {
        if (r.week >= currentWeek) continue;
        if (!weeks.has(r.week)) weeks.set(r.week, { open: false, scores: [] });
        const w = weeks.get(r.week);
        if (!final(r)) w.open = true;
        w.scores.push(r.pf);
      }
    }
    const rows = entries.map((e) => {
      const all = { w: 0, l: 0, t: 0 };
      for (const r of e.results || []) {
        const week = weeks.get(r.week);
        if (!week || week.open) continue;
        const others = week.scores.slice();
        others.splice(others.indexOf(r.pf), 1);
        for (const score of others) {
          if (r.pf > score) all.w++;
          else if (r.pf < score) all.l++;
          else all.t++;
        }
      }
      const t = e.team;
      const faced = all.w + all.l + all.t;
      const games = t.wins + t.losses + (t.ties || 0);
      const expected = faced ? ((all.w + all.t / 2) / faced) * games : 0;
      const allPct = faced ? (all.w + all.t / 2) / faced : 0;
      return { ...e, all, expected, luck: t.wins + (t.ties || 0) / 2 - expected, allPct };
    });
    const byKey = new Map(rows.map((e) => [`${e.league.slug}:${e.team.id}`, e]));
    const byName = new Map(rows.map((e) => [`${e.league.slug}:${e.team.name}`, e]));
    const finished = (week) => weeks.has(week) && !weeks.get(week).open;
    for (const e of rows) {
      const faced = (e.results || []).filter((r) => r.opp && finished(r.week)).map((r) => byName.get(`${e.league.slug}:${r.opp.name}`))
        .concat((e.team.crossGames || []).filter((g) => finished(g.week)).map((g) => byKey.get(`${g.oppLeague.slug}:${g.opp.id}`)))
        .filter(Boolean);
      e.sos = faced.length ? faced.reduce((sum, o) => sum + o.allPct, 0) / faced.length : 0;
    }
    // 1 is the hardest schedule.
    rows.slice().sort((a, b) => b.sos - a.sos || a.rank - b.rank).forEach((e, i) => { e.sosRank = i + 1; });
    return rows;
  }

  // Report card: share of potential lineup points started this season. The order behind the letters stays hidden.
  const GRADES = ['A', 'B', 'C', 'D'];
  function addGrades(rows, lineups) {
    const ranked = rows.filter((e) => lineups && lineups[`${e.league.slug}:${e.team.id}`])
      .map((e) => {
        const [actual, potential] = lineups[`${e.league.slug}:${e.team.id}`];
        return { e, share: potential > 0 ? actual / potential : 0 };
      })
      .sort((a, b) => b.share - a.share);
    rows.forEach((e) => { e.grade = 0; e.letter = '—'; });
    ranked.forEach(({ e }, i) => {
      const band = Math.min(GRADES.length - 1, Math.floor(i / 9));
      e.letter = GRADES[band];
      e.grade = GRADES.length - band;
    });
  }

  async function renderLuckIndex(entries, week, body, token) {
    // A past season has no lineup grades (and its file's week is the first playoff week, so this is the regular season).
    const graded = !ARCHIVE;
    const file = graded ? await thisWeekFile() : null;
    if (token !== renderToken) return;
    const all = luckIndex(entries, week);
    if (graded) addGrades(all, file && file.lineups);
    const others = all.length - 1;
    if (!all.some((e) => e.all.w + e.all.l + e.all.t)) {
      body().innerHTML = '<div class="state"><strong>The Luck Index isn\'t available yet.</strong><span>It fills in once the first week is final.</span></div>';
      return;
    }
    const signed = (n) => {
      const v = Math.abs(n) < 0.05 ? 0 : n;
      return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
    };
    // Hardest schedule red, easiest green, fading through the plain text color in the middle.
    const sosColor = (sosRank) => {
      const t = (sosRank - 1) / Math.max(1, all.length - 1);
      return t < 0.5
        ? `color-mix(in srgb, var(--loss) ${Math.round((1 - t * 2) * 100)}%, var(--text))`
        : `color-mix(in srgb, var(--win) ${Math.round((t * 2 - 1) * 100)}%, var(--text))`;
    };
    // Click Rank / Luck to sort; click the active one again to flip direction.
    let sort = { key: 'luck', dir: 'desc' };
    const draw = () => {
      const val = (e) => (sort.key === 'rank' ? -e.rank : e[sort.key]);
      const rows = all.slice().sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)) || a.rank - b.rank);
      const scrolled = body().querySelector('.table-wrap')?.scrollLeft || 0;
      body().innerHTML = `
      <p class="pw-status">${ARCHIVE ? `The ${SEASON} regular season` : 'Through the last finished week'}. A positive number means more wins than the team's scores would usually earn.</p>
      ${graded ? '<p class="pw-status">Grade reflects how well a team has set their starters vs. their bench.</p>' : ''}
      <div class="panel">
        <p class="pw-sort">Table sortable by Rank, ${graded ? 'Grade, ' : ''}Strength of Schedule, or Luck</p>
        <p class="pw-hint">Swipe the table sideways to see every column</p>
        <div class="table-wrap">
          <table class="standings power">
            <thead><tr>
              ${sortHeader(sort, 'rank', 'Rank', 'c-rank', 'Sort by overall standings rank')}<th>Team</th>${graded ? sortHeader(sort, 'grade', 'Grade', 'c-num', 'Sort by lineup grade') : ''}<th class="c-num">Overall</th>
              <th class="c-num" title="Record if the team had played all ${others} others every week">All-play</th><th class="c-num" title="Wins an average schedule would give these scores">Expected<br>wins</th>${sortHeader(sort, 'sos', 'Schedule<br>strength', 'c-num', 'Sort by strength of schedule')}${sortHeader(sort, 'luck', 'Luck', 'c-num', 'Sort by luck')}
            </tr></thead>
            <tbody>${rows.map(({ team: t, league, rank, all: a, expected, luck, sosRank, letter }) => `
              <tr class="lg-row" style="--lc:var(--${league.theme})">
                <td class="c-rank"><span class="rank">${rank}</span></td>
                <td class="c-team">
                  <a class="team-cell" href="#/${league.slug}/rosters?team=${t.id}">
                    ${teamLogo(t, league)}
                    <span><strong>${esc(t.name)}</strong><small>${esc(t.owner)}${champBadges(t)}</small><small class="lg-name">${esc(league.displayName)}</small></span>
                  </a>
                </td>
                ${graded ? `<td class="c-num pw-letter grade-${letter.toLowerCase()}">${letter}</td>` : ''}
                <td class="c-num c-rec">${record(t)}</td>
                <td class="c-num">${a.w}-${a.l}${a.t ? `-${a.t}` : ''}</td>
                <td class="c-num">${f1(expected)}</td>
                <td class="c-num pw-title" style="color:${sosColor(sosRank)}">${sosRank}</td>
                <td class="c-num pw-title ${luck >= 0.05 ? 'luck-up' : luck <= -0.05 ? 'luck-down' : ''}">${signed(luck)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <p class="fineprint">All-play is the record a team would have if its score each week were compared with all ${others} other teams. Expected wins applies that win rate to the games the team has actually played. Schedule strength ranks all ${all.length} teams by the average all-play win rate of the opponents they've faced, with 1 being the hardest schedule. Luck is actual wins minus expected wins. All of it covers in-league and cross-league games from ${ARCHIVE ? 'the regular season (Weeks 1-14)' : 'finished weeks only'}.</p>`;
      body().querySelector('.table-wrap').scrollLeft = scrolled;
      body().querySelectorAll('th button[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        sort = key === sort.key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
        draw();
        body().querySelector(`th button[data-sort="${key}"]`).focus();
      }));
    };
    draw();
  }

  // ---------- this week ----------
  // nums replaces the usual score on the right.
  function twTeam(side, week, live, nums) {
    return `
      <a class="team-cell tw-team" href="#/${side.league.slug}/rosters?team=${side.team.id}&week=${week}" style="--lc:var(--${side.league.theme})">
        ${teamLogo(side.team, side.league)}
        <span><strong>${esc(side.team.name)}</strong><small>${esc(side.team.owner)}</small><small class="lg-name">${esc(side.league.displayName)}</small></span>
        <span class="tw-nums">${nums || `<b class="tw-score">${f2(side.score)}</b><small>${live ? `proj. ${f1(side.proj)}` : 'Final'}</small>`}</span>
      </a>`;
  }

  function twCard(label, inner, note, link) {
    return `
      <article class="panel tw-card" data-card="${esc(label)}">
        <h3 class="tw-label">${link ? `<a href="${esc(link)}" title="View this matchup">${esc(label)}<i class="tw-go" aria-hidden="true"></i></a>` : esc(label)}</h3>
        ${inner}
        ${note ? `<p class="tw-note">${esc(note)}</p>` : ''}
      </article>`;
  }

  function twGameCard(label, g, note, week, live) {
    if (!g) return '';
    return twCard(label, `<div class="tw-game">${twTeam(g.high, week, live)}${twTeam(g.low, week, live)}</div>`, note, g.link);
  }

  // One team that won or lost both games, with a link to each.
  function twSweepCard(label, x, word, week, live) {
    if (!x) return '';
    const games = x.games.map((g) => `<li><a href="${esc(g.link)}" title="View this matchup"><span>${word} ${esc(g.opp.team.name)}</span><b>${live ? f1(g.opp.proj) : f2(g.opp.score)}</b></a></li>`).join('');
    return twCard(label, `<div class="tw-game">${twTeam(x.side, week, live)}<ul class="tw-opps">${games}</ul></div>`);
  }

  function twMoversCard(movers, week, live) {
    if (!movers) return '';
    const row = (m, up) => `<li>${twTeam(m.side, week, live, `<b class="tw-score ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(m.from - m.to)}</b><small>#${m.from} → #${m.to}</small>`)}</li>`;
    const group = (title, list, up) => (list.length ? `<h4 class="tw-sub">${title}</h4><ul class="tw-list plain">${list.map((m) => row(m, up)).join('')}</ul>` : '');
    return twCard('Biggest Movers', `${group('Climbed', movers.up, true)}${group('Fell', movers.down, false)}`, `In the overall standings${live ? ', if the projected results hold' : ''}`);
  }

  function twStreaksCard(streaks, week, live) {
    if (!streaks) return '';
    const row = (x, letter) => `<li>${twTeam(x.side, week, live, `<b class="tw-score ${letter === 'W' ? 'up' : 'down'}">${letter}${x.length}</b><small>${letter === 'W' ? 'won' : 'lost'} in a row</small>`)}</li>`;
    const group = (title, list, letter) => (list.length ? `<h4 class="tw-sub">${title}</h4><ul class="tw-list plain" data-streak="${letter}">${list.map((x) => row(x, letter)).join('')}</ul>` : '');
    return twCard('Hottest and Coldest', `${group('Hottest', streaks.hot, 'W')}${group('Coldest', streaks.cold, 'L')}`, `Current streaks, in-league and cross-league${live ? ', if the projected results hold' : ''}`);
  }

  // The all-time tags on the Weekly Snapshot: a card's team gets a gold tag when it lands in the matching
  // Archives > Records list (same data, same rules, same list length), counting only what had happened by that
  // week. Earlier seasons come from their games.json (plus playoff games, for the score lists); this season from
  // its own games.json, weeks before the one shown.
  let allTimePool = null;
  function teamWeeks(file) {
    const by = new Map();
    for (const [week, a, sa, b, sb, link] of file.games) {
      const inLeague = link.includes('/matchups');
      for (const [key, pf, pa] of b === 'median' ? [[a, sa, sb]] : [[a, sa, sb], [b, sb, sa]]) {
        const id = key + '|' + week;
        if (!by.has(id)) by.set(id, { key, week, pf, games: [] });
        by.get(id).games.push({ result: pf > pa ? 'W' : pf < pa ? 'L' : 'T', inLeague });
      }
    }
    return [...by.values()];
  }
  // A week's games in streak order: a result that continues the running streak counts first, so a 1-1 week
  // extends a streak by one before ending it; otherwise the in-league game first. A tie ends a streak.
  const streakOrder = (games, running, inLeague = (g) => g.inLeague) => games.slice()
    .sort((x, y) => (y.result === running) - (x.result === running) || !!inLeague(y) - !!inLeague(x));
  // Streaks within one season, through a given week.
  function seasonRuns(weeks, through) {
    const runs = [];
    const byTeam = new Map();
    for (const w of weeks) if (w.week <= through) (byTeam.get(w.key) || byTeam.set(w.key, []).get(w.key)).push(w);
    for (const [key, list] of byTeam) {
      list.sort((x, y) => x.week - y.week);
      let run = null;
      for (const w of list) {
        for (const g of streakOrder(w.games, run && run.result)) {
          if (run && run.result === g.result) { run.n++; run.end = w.week; continue; }
          if (run) runs.push(run);
          run = g.result === 'T' ? null : { key, result: g.result, n: 1, end: w.week };
        }
      }
      if (run) runs.push(run);
    }
    return runs;
  }
  // Head-to-head margins (not 2023's games against the median): [{ week, margin }]
  const margins = (file) => file.games.filter((g) => g[3] !== 'median').map((g) => ({ week: g[0], margin: Math.round(Math.abs(g[2] - g[4]) * 100) / 100 }));
  function allTimeFacts() {
    if (!allTimePool) {
      const json = (url) => fetch(url, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const past = SEASON_PAGES.filter((y) => y < SEASON);
      allTimePool = Promise.all([json(DATA + 'games.json'), ...past.flatMap((y) => [json('data/seasons/' + y + '/games.json'), json('data/seasons/' + y + '/playoffs.json')])])
        .then(([mine, ...rest]) => {
          const prior = { scores: [], weeks: [], runs: [], margins: [] };
          past.forEach((y, i) => {
            const [games, playoffs] = [rest[i * 2], rest[i * 2 + 1]];
            if (games) {
              const weeks = teamWeeks(games);
              prior.weeks.push(...weeks);
              prior.scores.push(...weeks.map((w) => w.pf));
              prior.runs.push(...seasonRuns(weeks, Infinity));
              prior.margins.push(...margins(games).map((m) => m.margin));
            }
            if (playoffs) for (const g of playoffs.games) for (const t of g.teams) prior.scores.push(t.score);
          });
          const ok = mine && mine.season === SEASON;
          return { prior, season: ok ? teamWeeks(mine) : [], seasonMargins: ok ? margins(mine) : [] };
        });
    }
    return allTimePool;
  }

  async function tagAllTime(root, a, week, token) {
    const pool = await allTimeFacts();
    if (token !== renderToken || !root.isConnected) return;
    const before = pool.season.filter((w) => w.week < week);
    const has = (w, r) => w.games.some((g) => g.result === r);
    const swept = (w, r) => w.games.length >= 2 && w.games.every((g) => g.result === r);
    const weeksWhere = (test) => pool.prior.weeks.filter(test).concat(before.filter(test)).map((w) => w.pf);
    const label = (rank, words) => (rank === 1 ? words[0].toUpperCase() + words.slice(1) : ordinal(rank) + '-' + words) + ' all time';
    const tag = (el, rank, limit, words) => {
      if (!el || rank > limit) return;
      el.querySelector(':scope > span').insertAdjacentHTML('beforeend', '<small class="tw-alltime">' + esc(label(rank, words)) + '</small>');
    };
    // Rank = 1 + how many entries beat it; others = that week's other entries in the same card.
    const rankOf = (value, pool, others, better) => 1 + pool.filter((v) => better(v, value)).length + others.filter((v) => better(v, value)).length;
    const high = (v, x) => v > x;
    const low = (v, x) => v < x;
    const card = (name) => root.querySelector('[data-card="' + name + '"]');
    const allScores = pool.prior.scores.concat(before.map((w) => w.pf));
    const list = (name) => [...((card(name) || root).querySelectorAll('.tw-list > li > .tw-team'))];
    const scoreTags = (name, sides, better, words) => list(name).forEach((el, i) => {
      const s = sides[i];
      if (s) tag(el, rankOf(s.score, allScores, sides.filter((o) => o !== s).map((o) => o.score), better), 50, words);
    });
    if (card('Top Scores')) scoreTags('Top Scores', a.scores, high, 'highest score');
    if (card('Lowest Scores')) scoreTags('Lowest Scores', a.lowest, low, 'lowest score');
    const one = (name, i, side, pool, better, limit, words) => {
      const c = card(name);
      if (c && side) tag(c.querySelectorAll('.tw-game > .tw-team')[i], rankOf(side.score, pool, [], better), limit, words);
    };
    if (a.badBeat) one('Best Losing Score', 1, a.badBeat.low, weeksWhere((w) => has(w, 'L')), high, 30, 'most points in a loss');
    if (a.luckyWin) one('Lowest Winning Score', 0, a.luckyWin.high, weeksWhere((w) => has(w, 'W')), low, 30, 'fewest points in a win');
    if (a.lostBoth) one('Most Points, Lost Both', 0, a.lostBoth.side, weeksWhere((w) => swept(w, 'L')), high, 15, 'most points in an 0-2 week');
    if (a.wonBoth) one('Fewest Points, Won Both', 0, a.wonBoth.side, weeksWhere((w) => swept(w, 'W')), low, 15, 'fewest points in a 2-0 week');
    const allMargins = pool.prior.margins.concat(pool.seasonMargins.filter((m) => m.week < week).map((m) => m.margin));
    const marginOf = (g) => Math.round(g.margin * 100) / 100;
    if (a.blowout) one('Biggest Blowout', 0, { score: marginOf(a.blowout) }, allMargins, high, 30, 'biggest blowout');
    if (a.closest) one('Closest Game', 0, { score: marginOf(a.closest) }, allMargins, low, 30, 'closest game');
    // Streaks need the whole week saved, to see where every team's run stood.
    const c = card('Hottest and Coldest');
    if (a.streaks && c && pool.season.some((w) => w.week === week)) {
      const runs = seasonRuns(pool.season, week);
      for (const [kind, letter, words] of [['hot', 'W', 'winning streak'], ['cold', 'L', 'losing streak']]) {
        const els = [...c.querySelectorAll('[data-streak="' + letter + '"] > li > .tw-team')];
        a.streaks[kind].forEach((x, i) => {
          const key = x.side.league.slug + ':' + x.side.team.id;
          const mine = runs.find((r) => r.key === key && r.result === letter && r.end === week);
          const others = runs.filter((r) => r.result === letter && r !== mine).map((r) => r.n);
          const prior = pool.prior.runs.filter((r) => r.result === letter).map((r) => r.n);
          tag(els[i], rankOf(x.length, prior, others, high), 10, 'longest ' + words);
        });
      }
    }
  }

  // Finished weeks are saved by tools/run-this-week.js. A week that isn't in the file comes live from ESPN instead.
  let thisWeekCache = null;
  function thisWeekFile() {
    if (!thisWeekCache || Date.now() - thisWeekCache.t > 300000) {
      thisWeekCache = {
        t: Date.now(),
        p: fetch(`${DATA}this-week.json`, { cache: 'no-cache' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => (d && d.season === SEASON ? d : null))
          .catch(() => null),
      };
    }
    return thisWeekCache.p;
  }

  // Turns a saved week back into the shape the cards draw from.
  function savedAwards(file, week) {
    const saved = file && file.weeks[week];
    if (!saved) return null;
    const side = ([key, score]) => {
      const [slug] = key.split(':');
      const cfg = LEAGUES.find((l) => l.slug === slug);
      const id = Number(key.split(':')[1]);
      return {
        team: { id, ...file.teams[key] },
        league: { slug, theme: cfg.theme, displayName: cfg.name, logo: cfg.logo },
        score,
        proj: score,
      };
    };
    const game = (g) => (g ? { high: side(g.high), low: side(g.low), link: g.link, margin: g.margin, gap: g.gap } : null);
    const sweep = (x) => (x ? { side: side(x.team), games: x.games.map((g) => ({ opp: side(g.opp), link: g.link })) } : null);
    const move = ([key, from, to]) => ({ side: side([key, 0]), from, to });
    const streak = ([key, length]) => ({ side: side([key, 0]), length });
    return {
      lowest: saved.lowest.map(side),
      lostBoth: sweep(saved.lostBoth),
      wonBoth: sweep(saved.wonBoth),
      managers: saved.managers.map(([key, actual, potential]) => ({ side: side([key, actual]), actual, potential })),
      movers: saved.movers && { up: saved.movers.up.map(move), down: saved.movers.down.map(move) },
      streaks: saved.streaks && { hot: saved.streaks.hot.map(streak), cold: saved.streaks.cold.map(streak) },
      scores: saved.scores.map(side),
      closest: game(saved.closest),
      blowout: game(saved.blowout),
      upset: game(saved.upset),
      badBeat: game(saved.badBeat),
      luckyWin: game(saved.luckyWin),
    };
  }

  async function renderThisWeek(body, token, params) {
    const [currentWeek, file] = await Promise.all([ESPN.getCurrentWeek(LEAGUES[0].id), thisWeekFile()]);
    if (token !== renderToken) return;
    const lastWeek = ARCHIVE ? ARCHIVE.lastWeek : currentWeek; // a past season ends at its last regular week
    const asked = Number(params.get('week'));
    const picked = Number.isInteger(asked) && asked >= 1 && asked <= lastWeek;
    let week = picked ? asked : lastWeek;
    let a = week < currentWeek ? savedAwards(file, week) : null;
    let crossOk = true;
    let live = false;
    let notStarted = false;
    if (!a) {
      const leagues = await loadAllLeagues();
      if (token !== renderToken) return;
      let data = await thisWeekGames(leagues, week);
      if (token !== renderToken) return;
      // Opening the tab before a new week has any scores shows last week instead.
      notStarted = !picked && week === currentWeek && !data.sides.some((s) => s.score > 0);
      if (notStarted && week > 1) {
        week -= 1;
        a = savedAwards(file, week);
        if (!a) {
          data = await thisWeekGames(leagues, week);
          if (token !== renderToken) return;
        }
      }
      if (!a) {
        live = week === currentWeek && data.sides.some(stillPlaying);
        const prev = week === 1 ? {} : file && file.weeks[week - 1] && file.weeks[week - 1].standing;
        a = data.sides.some((s) => s.score > 0) ? thisWeekAwards(data, live, prev) : { scores: [] };
        crossOk = data.crossOk;
      }
    }
    const weekSelect = () => {
      const options = Array.from({ length: lastWeek }, (_, i) => i + 1).map((w) =>
        `<option value="${w}" ${w === week ? 'selected' : ''}>Week ${w}${w === currentWeek ? ' · current' : ''}</option>`).join('');
      return `<label class="select"><span class="sr-only">Choose week</span><select id="week-select">${options}</select></label>`;
    };
    const bindWeekSelect = () => body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/home/this-week?week=${e.target.value}`;
    });
    document.getElementById('home-eyebrow').textContent = `${SEASON} · Week ${week}`;
    if (!a.scores.length) {
      body().innerHTML = `<div class="matchups-bar"><span></span>${weekSelect()}</div><div class="state"><strong>Week ${week} hasn't started yet.</strong><span>The snapshot fills in once games kick off.</span></div>`;
      bindWeekSelect();
      return;
    }
    const status = notStarted
      ? `Final scores from Week ${week}. Week ${currentWeek} appears here once its games kick off.`
      : live
        ? `Week ${week} is in progress, so cards are based on projected final scores. Refreshes every minute.`
        : `Week ${week} results.`;
    const pts = (n) => (live ? f1(n) : f2(n));
    const u = a.upset;
    body().innerHTML = `
      <div class="matchups-bar">
        <p class="pw-status tw-status">${esc(status)}</p>
        ${weekSelect()}
      </div>
      <div class="tw-grid">
        ${twCard('Top Scores', `<ol class="tw-list">${a.scores.map((t) => `<li>${twTeam(t, week, live)}</li>`).join('')}</ol>`)}
        ${twCard('Lowest Scores', `<ol class="tw-list">${a.lowest.map((t) => `<li>${twTeam(t, week, live)}</li>`).join('')}</ol>`)}
        ${a.managers
          ? twCard('Top Managers', `<ol class="tw-list">${a.managers.map((m) => `<li>${twTeam(m.side, week, live, `<b class="tw-score">${f1(m.actual / m.potential * 100)}%</b><small>${f2(m.actual)} of ${f2(m.potential)}</small>`)}</li>`).join('')}</ol>`, 'Share of their best possible points they started')
          : twCard('Top Managers', '', `Appears once Week ${week} is final and every player's points are in.`)}
        ${twGameCard('Closest Game', a.closest, a.closest && `${live ? 'Projected margin' : 'Decided by'} ${pts(a.closest.margin)}`, week, live)}
        ${twGameCard('Biggest Blowout', a.blowout, a.blowout && `${live ? 'Projected to win by' : 'Won by'} ${pts(a.blowout.margin)}`, week, live)}
        ${twGameCard('Biggest Upset', u, u && `Projected to lose by ${f1(u.gap)} before kickoff, ${live ? 'now projected to win by' : 'won by'} ${pts(u.margin)}`, week, live)}
        ${twGameCard('Best Losing Score', a.badBeat, a.badBeat && `${live ? 'Projected to lose despite' : 'Lost despite scoring'} ${pts(live ? a.badBeat.low.proj : a.badBeat.low.score)}`, week, live)}
        ${twSweepCard('Most Points, Lost Both', a.lostBoth, live ? 'Projected to lose to' : 'Lost to', week, live)}
        ${twSweepCard('Fewest Points, Won Both', a.wonBoth, live ? 'Projected to beat' : 'Beat', week, live)}
        ${twGameCard('Lowest Winning Score', a.luckyWin, a.luckyWin && `${live ? 'Projected to win with' : 'Won with'} ${pts(live ? a.luckyWin.high.proj : a.luckyWin.high.score)}`, week, live)}
        ${twMoversCard(a.movers, week, live)}
        ${twStreaksCard(a.streaks, week, live)}
      </div>
      <p class="fineprint">Covers in-league and cross-league games across all four leagues${crossOk ? '' : ' (cross-league games are unavailable right now, so only in-league games are shown)'}. While games are in progress, teams are ranked by ESPN's live projected final score, which counts points already scored plus projections for players yet to finish. The biggest upset compares that with what each team's starters were projected to score before the week began. Gold tags mark a final result that made one of the all-time lists on Archives &gt; Records, ranked as of that week.</p>`;
    bindWeekSelect();
    attachReactions(body(), [...body().querySelectorAll('.tw-card[data-card]')].map((el) => ({
      el, target: `snap:${SEASON}:w${week}:${slugify(el.dataset.card)}`,
    })));
    // Final scores only: a live score is still moving.
    if (!live) tagAllTime(body(), a, week, token);
    if (live && LIVE_REFRESH_MS) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async function tick() {
        if (token !== renderToken) return;
        if (document.hidden) { refreshTimer = setTimeout(tick, LIVE_REFRESH_MS); return; }
        try {
          await renderThisWeek(body, token, params);
        } catch (err) {
          console.error(err);
          refreshTimer = setTimeout(tick, LIVE_REFRESH_MS);
        }
      }, LIVE_REFRESH_MS);
    }
  }

  // ---------- home ----------
  const HOME_TABS = ARCHIVE ? ['final-standings', 'standings', 'this-week', 'playoff-bracket', 'toilet-bowl', 'luck-index']
    : ['standings', 'this-week', 'title-odds', 'playoff-bracket', 'toilet-bowl', 'luck-index'];
  const HOME_TAB_NAMES = { standings: 'Standings', 'final-standings': 'Final Standings', 'this-week': 'Weekly Snapshot', 'title-odds': 'Title Odds', 'playoff-bracket': 'Playoffs', 'toilet-bowl': 'Toilet Bowl', 'luck-index': 'Luck Index' };

  function sortHeader(sort, key, label, cls, title) {
    const on = sort.key === key;
    const aria = on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="${cls} sortable ${on ? 'sorted' : ''}" aria-sort="${aria}">
        <button type="button" data-sort="${key}" title="${title}">${label}<i class="arrow ${on ? sort.dir : ''}" aria-hidden="true"></i></button></th>`;
  }

  // Every team's playoff, league title and Grand Champion odds, from the same weekly run as the Power Rankings.
  async function renderTitleOdds(entries, week, body, token) {
    const locked = await lockedRankings();
    if (token !== renderToken) return;
    if (!locked) {
      body().innerHTML = '<div class="state"><strong>Title Odds aren\'t available yet.</strong><span>They\'re calculated once a week, after ESPN finalizes the previous week.</span></div>';
      return;
    }
    const all = entries.map((e) => ({ ...e, o: locked.odds[`${e.league.slug}:${e.team.id}`] || BLANK_ODDS }));
    // Click Rank / Grand Champion to sort; click the active one again to flip direction.
    let sort = { key: 'grand', dir: 'desc' };
    const draw = () => {
      const val = (e) => (sort.key === 'rank' ? -e.rank : e.o.grand);
      const rows = all.slice().sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b))
        || b.o.title - a.o.title || b.o.playoffs - a.o.playoffs || a.rank - b.rank);
      const scrolled = body().querySelector('.table-wrap')?.scrollLeft || 0;
      body().innerHTML = `
      <p class="pw-status">${esc(lockedStatus(locked, week))}</p>
      <div class="panel">
        <p class="pw-sort">Table sortable by Rank or Grand Champion Odds</p>
        <p class="pw-hint">Swipe the table sideways to see every column</p>
        <div class="table-wrap">
          <table class="standings power">
            <thead><tr>
              ${sortHeader(sort, 'rank', 'Rank', 'c-rank', 'Sort by overall standings rank')}<th>Team</th><th class="c-num">Overall</th>
              <th class="c-num">Playoffs</th><th class="c-num">Win league</th>${sortHeader(sort, 'grand', 'Grand<br>Champion', 'c-num', 'Sort by Grand Champion odds')}
            </tr></thead>
            <tbody>${rows.map(({ team: t, league, o, rank }) => `
              <tr class="lg-row" style="--lc:var(--${league.theme})">
                <td class="c-rank"><span class="rank">${rank}</span></td>
                <td class="c-team">
                  <a class="team-cell" href="#/${league.slug}/rosters?team=${t.id}">
                    ${teamLogo(t, league)}
                    <span><strong>${esc(t.name)}</strong><small>${esc(t.owner)}${champBadges(t)}</small><small class="lg-name">${esc(league.displayName)}</small></span>
                  </a>
                </td>
                <td class="c-num c-rec">${record(t)}</td>
                <td class="c-num">${oddsPct(o.playoffs)}</td>
                <td class="c-num">${oddsPct(o.title)}</td>
                <td class="c-num pw-title">${oddsPct(o.grand)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <p class="fineprint">Rank is each team's place in the overall standings. Each league's champion goes to the Champions Cup in Week 17, where the highest score of the four wins. Estimates from ${locked.sims.toLocaleString('en-US')} simulations of the rest of the season, the same run as the Power Rankings tabs.</p>`;
      body().querySelector('.table-wrap').scrollLeft = scrolled;
      body().querySelectorAll('th button[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
        const key = btn.dataset.sort;
        sort = key === sort.key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
        draw();
        body().querySelector(`th button[data-sort="${key}"]`).focus();
      }));
    };
    draw();
  }

  async function renderHome(sub, params) {
    const token = ++renderToken;
    document.body.dataset.theme = 'home';
    document.title = 'Home · Microgen Fantasy Football';
    main.innerHTML = `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-seal.png?v=2" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow" id="home-eyebrow">${SEASON}</p>
          <h1 class="page-title home-title">Microgen Fantasy Football</h1>
          <p class="hero-dots">${LEAGUES.map((l) => `<span><i class="dot" style="--c:var(--${l.theme})"></i>${esc(l.name)}</span>`).join('')}</p>
        </div>
      </section>
      <nav class="subtabs ${HOME_TABS.length === 4 ? 'four' : ''}" aria-label="Home sections">
        ${HOME_TABS.map((s) => `<a href="#/home/${s}" class="${s === sub ? 'active' : ''}" ${s === sub ? 'aria-current="page"' : ''}>${HOME_TAB_NAMES[s]}</a>`).join('')}
      </nav>
      <div id="league-body">${loading()}</div>`;
    const body = () => document.getElementById('league-body');
    try {
      if (sub === 'this-week') {
        await renderThisWeek(body, token, params);
        return;
      }
      const file = await lockedStandings();
      if (token !== renderToken) return;
      let week;
      let entries;
      if (file) {
        week = file.week;
        entries = LEAGUES.flatMap((cfg) => {
          const { league, results } = lockedLeague(file, cfg);
          return league.teams.map((team) => ({ team, league, results: results.get(team.id) }));
        });
        entries.sort((a, b) => b.team.pct - a.team.pct || b.team.pf - a.team.pf);
        entries.forEach((e, i) => { e.rank = i + 1; });
      } else {
        const o = await overallRecords();
        if (token !== renderToken) return;
        week = o.currentWeek;
        const results = await Promise.all(o.leagues.map((l) => ESPN.getResults(l)));
        if (token !== renderToken) return;
        entries = rankAllTeams(o); // standings rank stays with the team when re-sorted
        entries.forEach((e) => { e.results = results[o.leagues.findIndex((l) => l.slug === e.league.slug)].get(e.team.id); });
      }
      document.getElementById('home-eyebrow').textContent = ARCHIVE ? `${SEASON} season · Final` : `${SEASON} · Week ${week}`;
      if (sub === 'final-standings') {
        await renderSeasonFinal(body, token);
        return;
      }
      if (ARCHIVE && (sub === 'playoff-bracket' || sub === 'toilet-bowl')) {
        await renderSeasonBracket(entries, sub === 'toilet-bowl' ? 'toilet' : 'playoffs', body, token);
        return;
      }
      if (sub === 'title-odds') {
        await renderTitleOdds(entries, week, body, token);
        return;
      }
      if (sub === 'playoff-bracket') {
        await renderPlayoffBracket(entries, week, body, token);
        return;
      }
      if (sub === 'toilet-bowl') {
        await renderToiletBowl(entries, week, body, token);
        return;
      }
      if (sub === 'luck-index') {
        await renderLuckIndex(entries, week, body, token);
        return;
      }

      // Click Rank / Overall / PF / PA to sort; click the active one again to flip direction.
      let sort = { key: 'rank', dir: 'desc' };
      const draw = () => {
        const val = (e) => (sort.key === 'rank' ? -e.rank : e.team[sort.key]);
        const sorted = entries.slice().sort((a, b) => (sort.dir === 'desc' ? val(b) - val(a) : val(a) - val(b)) || a.rank - b.rank);
        body().innerHTML = standingsTable(sorted, { overall: true, currentWeek: week, showLeague: true, sort });
        body().querySelectorAll('th button[data-sort]').forEach((btn) => btn.addEventListener('click', () => {
          const key = btn.dataset.sort;
          sort = key === sort.key ? { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
          draw();
          body().querySelector(`th button[data-sort="${key}"]`).focus();
        }));
      };
      draw();
    } catch (err) {
      if (token !== renderToken) return;
      console.error(err);
      body().innerHTML = errorBox(err, location.hash);
    }
  }

  // ---------- rosters ----------
  function gameText(g) {
    if (g.state === 'bye') return '<span class="bye">BYE</span>';
    if (!g.opp) return '';
    const opp = `${g.home ? 'vs' : '@'} <img class="nfl" src="${ESPN.nflLogo(g.opp.abbrev)}" alt="" loading="lazy">${esc(g.opp.abbrev)}`;
    if (g.state === 'final') return `${opp} · <b class="final">Final</b>`;
    if (g.state === 'live') return `${opp} · <b class="live">Live</b>`;
    return `${opp} · ${ET.format(new Date(g.date))}`;
  }

  function playerCell(p, opts = {}) {
    if (!p.id) return `<div class="pcell"><span class="pname muted">Empty</span></div>`;
    const sub = opts.withLine && p.line ? `<span class="pline">${esc(p.line)}</span>` : '';
    return `
      <div class="pcell">
        <img class="headshot ${p.isDst ? 'dst' : ''}" src="${esc(p.headshot)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="pinfo">
          <span class="pname">${esc(p.name)}${p.proTeam && !p.isDst ? `<img class="nfl" src="${ESPN.nflLogo(p.proTeam.abbrev)}" alt="${esc(p.proTeam.abbrev)}" loading="lazy">` : ''}${p.injury ? `<em class="inj">${p.injury}</em>` : ''}</span>
          <span class="pmeta">${opts.showPos ? `${esc(p.pos)} · ` : ''}${gameText(p.game)}</span>
          ${sub}
        </div>
      </div>`;
  }

  // Once a player's game is final, flag whether they beat their projection.
  function vsProjection(p) {
    if (p.game.state !== 'final' || !(p.proj > 0)) return { cls: '', title: '' };
    const diff = p.points - p.proj;
    return {
      cls: diff >= 0 ? 'over' : 'under',
      title: ` title="Projected ${f1(p.proj)} · ${diff >= 0 ? '+' : ''}${f1(diff)}"`,
    };
  }

  function scoreCell(p) {
    if (!p.id) return '<td class="c-score"></td>';
    const played = p.game.state === 'final' || p.game.state === 'live' || p.hasPlayed && p.points;
    const { cls, title } = vsProjection(p);
    return played
      ? `<td class="c-score ${p.game.state} ${cls}"${title}><b>${f2(p.points)}</b><small>${p.game.state === 'final' ? 'Final' : 'Live'}</small></td>`
      : `<td class="c-score"><b>${f1(p.proj)}</b><small>Proj</small></td>`;
  }

  function rosterRows(players) {
    return players.map((p) => `
      <tr>
        <td class="c-slot"><span class="slot s-${p.slot.replace('/', '')}">${esc(p.slot)}</span></td>
        <td class="c-player">${playerCell(p, { withLine: true, showPos: p.slot === 'BE' || p.slot === 'IR' || p.slot === 'FLEX' })}</td>
        ${scoreCell(p)}
        <td class="c-num hide-sm">${esc(p.seasonRank)}</td>
        <td class="c-num hide-sm">${p.gp || '—'}</td>
        <td class="c-num hide-xs">${f2(p.fpts)}</td>
        <td class="c-num">${f2(p.ppg)}</td>
      </tr>`).join('');
  }

  // The roster's own score for the selected week: final, live with its projection, or projected.
  function teamScore(league, team, week, results, livePts, projPts) {
    const game = (results.get(team.id) || []).find((r) => r.week === week);
    const stat = (label, value, cls = '') => `<div class="ts-stat"><span class="ws-label">${label}</span><b class="ts-val ${cls}">${value}</b></div>`;
    let stats;
    if (week < league.currentWeek) stats = stat(`Week ${week} final score`, game ? f2(game.pf) : '—');
    else if (week > league.currentWeek) stats = stat(`Week ${week} projected score`, f1(projPts));
    else stats = stat(`Week ${week} current score`, f2(livePts), 'ts-live') + stat('Projected', f1(projPts));
    return `<section class="panel team-score">${stats}</section>`;
  }

  // One matchup card for the selected week, showing the opponent's score. Scores of games still to
  // finish come from fillOpponentScores. The whole card links to the matchup; the opponent's name
  // still goes to their roster.
  function scoreCard({ label, result, week, live, oppKey, opp, link, linkLabel }) {
    const go = `
        <a class="ws-go" href="${link}" aria-label="${esc(linkLabel)}"><span>View<span class="ws-go-more"> matchup</span></span><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`;
    if (result) {
      const word = { W: 'Win', L: 'Loss', T: 'Tie' }[result.result];
      return `
        <div class="week-score ${result.result}">
          <span class="wl ${result.result}">${result.result}</span>
          <div class="ws-main"><span class="ws-label">Week ${week} · ${label} · Final · ${word}</span>${opp}</div>
          <span class="ws-pts">${f2(result.pa)}</span>${go}
        </div>`;
    }
    return `
      <div class="week-score ${live ? 'now' : 'proj'}">
        <div class="ws-main">
          <span class="ws-label">Week ${week} · ${label} · ${live ? 'Live' : 'Projected'}</span>
          ${opp}
        </div>
        <span class="ws-pts" ${oppKey ? `data-opp="${oppKey}"` : ''}>—</span>${go}
      </div>`;
  }

  // The selected week's cards: the in-league game, or the bye matchup in its place, then the cross-league game.
  function weekScores(league, team, week, results, cross) {
    const game = (results.get(team.id) || []).find((r) => r.week === week);
    const live = week === league.currentWeek;
    const shared = { week, live };
    const key = `${league.slug}:${team.id}`;
    const played = cross && cross.out.get(key) ? cross.out.get(key).games : [];
    const games = cross ? (cross.byTeam.get(key) || []).filter((x) => x.week === week) : [];
    const crossCardFor = (x, label) => {
      const lname = x.opp.league.displayName || x.opp.league.name;
      const name = `${teamLogo(x.opp.team, x.opp.league, 'avatar xs')}<span>${esc(x.opp.team.name)}</span><i class="dot" style="--c:var(--${x.opp.league.theme})" title="${esc(lname)}"></i>`;
      return scoreCard({
        ...shared,
        label,
        result: played.find((p) => p.week === week && p.opp.id === x.opp.team.id && p.oppLeague.slug === x.opp.league.slug),
        oppKey: x.opp.missing ? null : `${x.opp.league.slug}:${x.opp.team.id}`,
        opp: x.opp.missing ? `<span class="ws-opp">vs ${name}</span>`
          : `<a class="ws-opp" href="#/${x.opp.league.slug}/rosters?team=${x.opp.team.id}&week=${week}">vs ${name}</a>`,
        link: `#/cross-league?week=${week}${x.game ? `&game=${x.game}` : ''}`,
        linkLabel: `View the week ${week} matchup against ${x.opp.team.name}`,
      });
    };
    const others = games.filter((x) => !x.bye).map((x) => crossCardFor(x, 'Cross-league'));
    const byeGame = games.find((x) => x.bye);
    let first;
    if (game && game.opp) {
      first = scoreCard({
        ...shared,
        label: 'In-league',
        result: game.result ? game : null,
        oppKey: `${league.slug}:${game.opp.id}`,
        opp: `<a class="ws-opp" href="#/${league.slug}/rosters?team=${game.opp.id}&week=${week}">vs ${teamLogo(game.opp, league, 'avatar xs')}<span>${esc(game.opp.name)}</span></a>`,
        link: `#/${league.slug}/matchups?week=${week}&game=${game.id}`,
        linkLabel: `View the week ${week} matchup against ${game.opp.name}`,
      });
    } else if (byeGame) {
      first = crossCardFor(byeGame, 'Bye matchup');
    } else {
      first = `
        <div class="week-score bye">
          <span class="wl bye">B</span>
          <div class="ws-main">
            <span class="ws-label">Week ${week} · Bye</span>
            <span class="ws-opp">No opponent this week</span>
          </div>
        </div>`;
    }
    return `
      <button class="toggle ws-toggle" type="button" id="ws-toggle" aria-expanded="${weekCardsOpen}" aria-controls="ws-cards">
        <span>${weekCardsOpen ? 'Hide' : 'View'} matchups</span>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="week-scores" id="ws-cards" ${weekCardsOpen ? '' : 'hidden'}>${first}${others.join('')}</div>`;
  }

  // Fetched when the cards are first opened, so the roster itself doesn't wait on other leagues.
  async function fillOpponentScores(root, league, week, token) {
    const cells = [...root.querySelectorAll('[data-opp]')];
    if (!cells.length) return;
    try {
      const leagues = await loadAllLeagues();
      const slugs = new Set(cells.map((c) => c.dataset.opp.split(':')[0]));
      const data = await Promise.all(leagues.filter((l) => slugs.has(l.slug)).map(async (l) => ({ l, d: await ESPN.getMatchups(l, week) })));
      if (token !== renderToken) return;
      const sides = new Map();
      for (const { l, d } of data) {
        for (const g of d.games) for (const s of [g.home, g.away]) if (s) sides.set(`${l.slug}:${s.team.id}`, s);
      }
      for (const cell of cells) {
        const side = sides.get(cell.dataset.opp);
        if (!side) continue;
        cell.innerHTML = week === league.currentWeek ? `${f2(side.score)}<small>Proj ${f1(side.proj)}</small>` : f1(side.proj);
        cell.removeAttribute('data-opp');
      }
    } catch (err) {
      console.warn('Opponent scores unavailable', err);
    }
  }

  // ---------- custom team logo controls (Rosters) ----------
  // A team's manager can upload a logo for this season; a moderator can put any team back on ESPN's.
  // logoEdit survives the live refresh, so a picked image isn't lost while a game is on.
  let logoEdit = { key: '', open: false, blob: null, preview: '', busy: false, msg: '', error: false };
  const logoRights = (team, league) => {
    const me = ACCOUNT && !ARCHIVE && ACCOUNT.state.me;
    if (!me || !me.league) return { mine: false, mod: false };
    return { mine: me.league === league.slug && me.team_id === team.id, mod: Boolean(me.moderator) };
  };

  function logoControl(team, league) {
    const img = teamLogo(team, league, 'avatar xl');
    const { mine, mod } = logoRights(team, league);
    const custom = Boolean(customLogo(team, league));
    if (!mine && !(mod && custom)) return img;
    const label = mine ? 'Change your team logo' : `Logo options for ${team.name}`;
    return `<button type="button" class="logo-btn" data-logo="toggle" data-key="${league.slug}:${team.id}" aria-expanded="${logoEdit.open && logoEdit.key === `${league.slug}:${team.id}`}" title="${esc(label)}" aria-label="${esc(label)}">
      ${img}<span class="logo-btn-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg></span>
    </button>`;
  }

  function logoPanel(team, league) {
    const key = `${league.slug}:${team.id}`;
    if (!logoEdit.open || logoEdit.key !== key) return '';
    const { mine, mod } = logoRights(team, league);
    const custom = Boolean(customLogo(team, league));
    const msg = logoEdit.msg ? `<p class="acct-msg${logoEdit.error ? ' error' : ''}" role="status">${esc(logoEdit.msg)}</p>` : '';
    const dis = logoEdit.busy ? ' disabled' : '';
    let inner = '';
    if (mine) {
      inner = logoEdit.preview ? `
        <div class="logo-preview">
          <img class="avatar xl" src="${logoEdit.preview}" alt="Your new logo">
          <div>
            <p>Here’s how it will look. It’s shown as a circle everywhere on the site.</p>
            <div class="logo-actions">
              <button type="button" class="btn" data-logo="save"${dis}>${logoEdit.busy ? 'Saving…' : 'Save logo'}</button>
              <button type="button" class="btn-quiet" data-logo="discard"${dis}>Choose another</button>
            </div>
          </div>
        </div>` : `
        <p>Upload an image to use as your team’s logo on this site. A square picture works best; it’s cropped to a circle.</p>
        <div class="logo-actions">
          <label class="btn logo-file">Upload an image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-logo="file"></label>
          ${custom ? `<button type="button" class="btn-quiet" data-logo="revert"${dis}>Use the ESPN logo</button>` : ''}
        </div>`;
    } else if (mod && custom) {
      inner = `
        <p>${esc(team.owner)} uploaded this logo. As a moderator, you can remove it and go back to the team’s ESPN logo.</p>
        <div class="logo-actions"><button type="button" class="btn btn-danger" data-logo="revert"${dis}>${logoEdit.busy ? 'Reverting…' : 'Revert to the ESPN logo'}</button></div>`;
    } else return '';
    return `<section class="panel logo-panel" aria-label="Team logo">
      <div class="logo-panel-head"><h3>${mine ? 'Your team logo' : 'Team logo'}</h3>
        <button type="button" class="btn-quiet" data-logo="close"${dis}>Close</button></div>
      ${inner}${msg}</section>`;
  }

  // Square-crops and shrinks a picked image to 256px, as WebP where the browser can make it (PNG otherwise).
  async function shrinkLogo(file) {
    if (file.size > 15 * 1024 * 1024) throw new Error('That image is over 15 MB. Try a smaller one.');
    const url = URL.createObjectURL(file);
    try {
      const im = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('That file couldn’t be opened as an image.'));
        i.src = url;
      });
      const side = Math.min(im.naturalWidth, im.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im, (im.naturalWidth - side) / 2, (im.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
      return blob && blob.type === 'image/webp' ? blob : new Promise((r) => c.toBlob(r, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Redraws only the logo and its panel, so the roster below (and any live scores) stay put.
  let shownRoster = null; // { team, league } on the Rosters tab, set by renderRosters
  function redrawLogo() {
    const head = document.querySelector('.team-head');
    const btn = head && head.querySelector('[data-logo="toggle"], .avatar.xl'); // the button, or the bare logo
    if (!head || !btn || !shownRoster) return;
    const { team, league } = shownRoster;
    btn.outerHTML = logoControl(team, league);
    const old = document.querySelector('.logo-panel');
    const html = logoPanel(team, league);
    if (old) old.outerHTML = html;
    else if (html) head.insertAdjacentHTML('afterend', html);
  }

  if (ACCOUNT && !ARCHIVE) {
    main.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-logo]');
      if (!b || b.tagName === 'INPUT') return;
      const act = b.dataset.logo;
      if (act === 'toggle') {
        const key = b.dataset.key;
        const open = !(logoEdit.open && logoEdit.key === key);
        if (logoEdit.preview) URL.revokeObjectURL(logoEdit.preview);
        logoEdit = { key, open, blob: null, preview: '', busy: false, msg: '', error: false };
      } else if (act === 'close' || act === 'discard') {
        if (logoEdit.preview) URL.revokeObjectURL(logoEdit.preview);
        logoEdit = { ...logoEdit, open: act !== 'close', blob: null, preview: '', msg: '', error: false };
      } else if (act === 'save' || act === 'revert') {
        if (act === 'revert' && !confirm('Go back to this team’s ESPN logo?')) return;
        logoEdit = { ...logoEdit, busy: true, msg: '', error: false };
        redrawLogo();
        try {
          const [slug, id] = logoEdit.key.split(':');
          if (act === 'save') await ACCOUNT.uploadLogo(logoEdit.blob);
          else await ACCOUNT.revertLogo(slug, Number(id));
          if (logoEdit.preview) URL.revokeObjectURL(logoEdit.preview);
          logoEdit = { ...logoEdit, open: false, blob: null, preview: '', busy: false };
          return; // the logo change redraws the page
        } catch (err) {
          logoEdit = { ...logoEdit, busy: false, msg: err.message || String(err), error: true };
        }
      } else return;
      redrawLogo();
    });
    main.addEventListener('change', async (e) => {
      const input = e.target.closest('input[data-logo="file"]');
      if (!input || !input.files[0]) return;
      try {
        const blob = await shrinkLogo(input.files[0]);
        logoEdit = { ...logoEdit, blob, preview: URL.createObjectURL(blob), msg: '', error: false };
      } catch (err) {
        logoEdit = { ...logoEdit, msg: err.message || String(err), error: true };
      }
      redrawLogo();
    });
    // Signing in or out changes who can edit; redraw the logo controls in place.
    ACCOUNT.onChange(() => { if (shownRoster && parseHash().parts[1] === 'rosters') redrawLogo(); });
  }

  async function renderRosters(league, body, params, token) {
    const week = clampWeek(league, params.get('week'));
    const [rosters, results, cross] = await Promise.all([
      ESPN.getRosters(league, week),
      ESPN.getResults(league),
      lockedStandings().then((file) => (file ? lockedCrossSchedules(file) : crossSchedules())).catch((err) => {
        console.warn('Cross-league schedule unavailable', err);
        return null;
      }),
    ]);
    if (token !== renderToken) return;
    const teamId = Number(params.get('team')) || league.teams[0].id;
    const team = league.teamById.get(teamId) || league.teams[0];
    const weekQs = week === league.currentWeek ? '' : `&week=${week}`;
    const note = week > league.currentWeek
      ? 'Upcoming week — showing the current roster with that week\'s projections.'
      : week < league.currentWeek ? `Lineup as it was set for week ${week}.` : '';
    const roster = rosters.byTeam.get(team.id) || { starters: [], bench: [] };
    const rank = league.teams.indexOf(team) + 1;
    const startersPts = roster.starters.reduce((s, p) => s + (p.hasPlayed ? p.points : 0), 0);
    const startersProj = roster.starters.reduce((s, p) => s + (p.hasPlayed ? p.points : p.proj), 0);

    const picker = league.teams.map((t) => `
      <a class="pick ${t.id === team.id ? 'active' : ''}" href="#/${league.slug}/rosters?team=${t.id}${weekQs}"${t.id === team.id ? 'aria-current="true"' : ''}>
        ${teamLogo(t, league)}<span>${esc(t.owner || t.abbrev)}</span>
      </a>`).join('');

    const teamKey = `${league.slug}:${team.id}`;
    const crossList = cross ? cross.byTeam.get(teamKey) || [] : [];
    const crossPlayed = cross && cross.out.get(teamKey) ? cross.out.get(teamKey).games : [];
    const pending = (w) => {
      const cur = w === league.currentWeek;
      return `<span class="wl pending">${cur ? '•' : '–'}</span><b class="muted">${cur ? 'In progress' : 'Upcoming'}</b>`;
    };
    const crossRow = (x) => {
      const g = crossPlayed.find((p) => p.week === x.week && p.opp.id === x.opp.team.id && p.oppLeague.slug === x.opp.league.slug);
      const lname = x.opp.league.displayName || x.opp.league.name;
      return `
        <li class="xl ${x.week === week ? 'current' : ''}">
          <span class="wk xl-tag">Cross</span>${g ? `<span class="wl ${g.result}">${g.result}</span><b>${f1(g.pf)}–${f1(g.pa)}</b>` : pending(x.week)}
          <a class="vs" href="#/cross-league?week=${x.week}${x.game ? `&game=${x.game}` : ''}" title="${esc(x.opp.team.name)} (${esc(lname)})">
            <span class="muted">vs</span>${teamLogo(x.opp.team, x.opp.league, 'avatar xs')}<span class="vs-name">${esc(x.opp.team.name)}</span><i class="dot" style="--c:var(--${x.opp.league.theme})"></i>
          </a>
        </li>`;
    };
    // One group per week: the in-league game (or bye), then that week's cross-league game(s).
    const sched = (results.get(team.id) || []).filter((r) => r.week <= league.regularSeasonWeeks || r.result).map((r) => {
      let res;
      if (r.result) res = `<span class="wl ${r.result}">${r.result}</span><b>${f1(r.pf)}–${f1(r.pa)}</b>`;
      else if (r.bye && r.week < league.currentWeek) res = `<span class="wl bye">B</span><b>${f1(r.pf)}</b>`;
      else res = pending(r.week);
      return `
        <ul class="sched-wk">
          <li class="${r.week === week ? 'current' : ''}">
            <a class="wk" href="#/${league.slug}/rosters?team=${team.id}&week=${r.week}" title="View week ${r.week} roster">Wk ${r.week}</a>${res}
            <a class="vs" href="#/${league.slug}/matchups?week=${r.week}&game=${r.id}">
              ${r.opp ? `<span class="muted">vs</span>${teamLogo(r.opp, league, 'avatar xs')}<span class="vs-name">${esc(r.opp.name)}</span>` : '<span class="muted">Bye week</span>'}
            </a>
          </li>
          ${crossList.filter((x) => x.week === r.week).map(crossRow).join('')}
        </ul>`;
    }).join('');

    const head = `<thead><tr><th class="c-slot"></th><th>Player</th><th class="c-score">Wk ${week}</th>
      <th class="c-num hide-sm">Rank</th><th class="c-num hide-sm">GP</th><th class="c-num hide-xs">FPTS</th><th class="c-num">PPG</th></tr></thead>`;

    shownRoster = { team, league };
    if (logoEdit.open && logoEdit.key !== `${league.slug}:${team.id}`) logoEdit = { ...logoEdit, open: false }; // another team: close the panel

    body().innerHTML = `
      <div class="picker" role="list">${picker}</div>
      <section class="team-head">
        ${logoControl(team, league)}
        <div>
          <h2>${esc(team.name)}</h2>
          <p class="team-stats">
            <span>${esc(team.owner)}${champBadges(team)}</span>
            <span><b>${ordinal(rank)}</b> place</span>
            <span><b>${record(team)}</b></span>
            <span><b>${f2(team.pf)}</b> PF</span>
            <span><b>${f2(team.pa)}</b> PA</span>
          </p>
        </div>
        <label class="select team-week">
          <span class="sr-only">Choose week</span>
          <select id="week-select">${weekOptions(league, week)}</select>
        </label>
      </section>
      ${logoPanel(team, league)}
      ${note ? `<p class="fineprint week-note">${esc(note)}</p>` : ''}
      <section class="panel week-panel">
        ${weekScores(league, team, week, results, cross)}
      </section>
      ${teamScore(league, team, week, results, startersPts, startersProj)}
      <div class="panel">
        <div class="table-wrap">
          <table class="roster">
            ${head}
            <tbody>${rosterRows(roster.starters)}</tbody>
            <tbody class="bench-head"><tr><th colspan="7">Bench</th></tr></tbody>
            <tbody>${rosterRows(roster.bench)}</tbody>
          </table>
        </div>
      </div>
      <section class="panel schedule">
        <button class="toggle" type="button" id="sched-toggle" aria-expanded="${scheduleOpen}" aria-controls="sched-body">
          <span>${scheduleOpen ? 'Hide' : 'Show'} season schedule</span>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="sched-grid" id="sched-body" ${scheduleOpen ? '' : 'hidden'}>${sched}</div>
      </section>`;

    body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/${league.slug}/rosters?team=${team.id}&week=${e.target.value}`;
    });
    body().querySelector('#ws-toggle').addEventListener('click', (e) => {
      weekCardsOpen = !weekCardsOpen;
      const btn = e.currentTarget;
      btn.setAttribute('aria-expanded', weekCardsOpen);
      btn.querySelector('span').textContent = `${weekCardsOpen ? 'Hide' : 'View'} matchups`;
      body().querySelector('#ws-cards').hidden = !weekCardsOpen;
      if (weekCardsOpen) fillOpponentScores(body(), league, week, token);
    });
    if (weekCardsOpen) fillOpponentScores(body(), league, week, token);
    body().querySelector('#sched-toggle').addEventListener('click', (e) => {
      scheduleOpen = !scheduleOpen;
      const btn = e.currentTarget;
      btn.setAttribute('aria-expanded', scheduleOpen);
      btn.querySelector('span').textContent = `${scheduleOpen ? 'Hide' : 'Show'} season schedule`;
      body().querySelector('#sched-body').hidden = !scheduleOpen;
    });
  }

  // ---------- matchups ----------
  // opts.badge replaces the league-seed badge; opts.rec replaces the in-league record.
  function sideHead(side, league, align, leading, opts = {}) {
    const t = side.team;
    const href = side.week ? `#/${league.slug}/rosters?team=${t.id}&week=${side.week}` : `#/${league.slug}/rosters?team=${t.id}`;
    return `
      <div class="side ${align} ${leading ? 'leading' : ''}" ${opts.style ? `style="${opts.style}"` : ''}>
        <div class="side-id">
          ${opts.badge || `<span class="seed">#${league.teams.indexOf(t) + 1}</span>`}
          <a class="side-name" href="${href}">${esc(t.name)}</a>
          <span class="side-owner">${esc(t.owner)}</span>
          <span class="side-rec" ${opts.recTitle ? `title="${esc(opts.recTitle)}"` : ''}>${opts.rec || record(t)}</span>
        </div>
        ${teamLogo(t, league, 'avatar lg')}
        <div class="side-score">
          <span class="score">${f2(side.score)}</span>
          <span class="proj">${side.proj == null ? 'Final' : `Proj <b>${f1(side.proj)}</b>`}</span>
        </div>
      </div>`;
  }

  function playedPts(p) {
    const { cls, title } = vsProjection(p);
    const label = p.game.state === 'live' ? 'Live' : p.game.state === 'final' ? 'Final' : 'Pts';
    return `<span class="lpts ${p.game.state} ${cls}"${title}><b>${f2(p.points)}</b><small>${label}</small></span>`;
  }

  function lineupColumn(side, league) {
    if (!side.lineup) return `<div class="lineup-col"><p class="muted pad">Lineup not set yet.</p></div>`;
    const row = (p) => `
      <li>
        <span class="slot s-${p.slot.replace('/', '')}">${esc(p.slot)}</span>
        ${playerCell(p, { withLine: true })}
        ${p.id ? (p.hasPlayed
          ? playedPts(p)
          : `<span class="lpts"><b>${f1(p.proj)}</b><small>Proj</small></span>`) : '<span></span>'}
      </li>`;
    return `
      <div class="lineup-col">
        <h4>${teamLogo(side.team, league, 'avatar xs')}${esc(side.team.name)}</h4>
        <ul class="lineup">${side.lineup.starters.map(row).join('')}</ul>
        <details class="bench">
          <summary>Bench (${side.lineup.bench.length})</summary>
          <ul class="lineup">${side.lineup.bench.map(row).join('')}</ul>
        </details>
      </div>`;
  }

  function matchupCard(g, league, top, closest, openIds, going, overall) {
    const standing = (side) => going && going.get(side.team.id);
    const asOf = (side) => {
      const s = standing(side);
      return s ? { rec: record(s), badge: s.rank ? `<span class="seed">#${s.rank}</span>` : '<span></span>' } : {};
    };
    if (g.bye) {
      const s = g.home;
      const score = g.byeState === 'upcoming' ? '' : `
        <div class="side-score bye-score">
          <span class="score">${f2(s.score)}</span>
          <span class="proj">${g.byeState === 'final' || s.proj == null ? 'Final' : `Proj <b>${f1(s.proj)}</b>`}</span>
        </div>`;
      return `
        <article class="matchup bye-card" data-id="${g.id}">
          <div class="bye-row">
            ${teamLogo(s.team, league, 'avatar lg')}
            <div class="bye-id">
              <a class="side-name" href="#/${league.slug}/rosters?team=${s.team.id}">${esc(s.team.name)}</a>
              <span class="side-owner">${esc(s.team.owner)} · ${record(standing(s) || s.team)}</span>
              <span class="pill">Bye week</span>
            </div>
            ${score}
          </div>
          ${s.lineup ? lineupToggle(g, openIds, lineupColumn(s, league), 'single') : ''}
        </article>`;
    }
    const pHome = Math.round(g.prob * 100);
    const homeLead = g.decided ? g.winner === 'home' : g.prob > 0.5;
    const awayLead = g.decided ? g.winner === 'away' : g.prob < 0.5;
    const hasLineups = g.home.lineup || g.away.lineup;
    return `
      <article class="matchup ${top ? 'featured' : ''}" data-id="${g.id}">
        ${top ? `<div class="flag">Matchup of the week</div>` : ''}
        ${cardTags(`${league.slug}:${g.home.team.id}`, `${league.slug}:${g.away.team.id}`, overall)}
        <div class="matchup-head">
          ${sideHead(g.home, league, 'left', homeLead, asOf(g.home))}
          <span class="vs-mark">vs</span>
          ${sideHead(g.away, league, 'right', awayLead, asOf(g.away))}
        </div>
        <div class="prob" role="img" aria-label="Win probability: ${esc(g.home.team.name)} ${pHome}%, ${esc(g.away.team.name)} ${100 - pHome}%">
          <span class="pct ${homeLead ? 'lead' : ''}">${pHome}%</span>
          <div class="bar"><i style="width:${pHome}%"></i></div>
          <span class="pct ${awayLead ? 'lead' : ''}">${100 - pHome}%</span>
        </div>
        <p class="prob-label">${g.decided ? 'Final' : 'Win probability'}</p>
        ${closest ? `<div class="banner"><span>${esc(closest)}</span></div>` : ''}
        ${hasLineups ? lineupToggle(g, openIds, lineupColumn(g.home, league) + lineupColumn(g.away, league)) : ''}
      </article>`;
  }

  function lineupToggle(g, openIds, inner, cls = '') {
    const open = openIds.has(g.id);
    return `
      <button class="toggle" type="button" aria-expanded="${open}" aria-controls="lu-${g.id}">
        <span>${open ? 'Hide lineups' : 'Show lineups'}</span>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="lineups ${cls}" id="lu-${g.id}" ${open ? '' : 'hidden'}>${inner}</div>`;
  }

  // Every team's overall rank and record going into a week, keyed `${slug}:${teamId}`. Later weeks
  // use the latest standings. Week 1 has records but no ranks yet. Empty if the data can't load.
  async function overallGoingInto(week) {
    try {
      const file = await lockedStandings();
      const all = file ? LEAGUES.map((cfg) => lockedLeague(file, cfg)) : await (async () => {
        const o = await overallRecords();
        return Promise.all(o.leagues.map(async (l) => {
          const league = Object.assign({}, l, { teams: l.teams.map((t) => Object.assign({}, t)) });
          applyOverall(league, o.out);
          return { league, results: await ESPN.getResults(l) };
        }));
      })();
      const last = Math.min(week - 1, Math.max(...all.map((e) => e.league.currentWeek)) - 1);
      const rows = all.flatMap(({ league, results }) => standingsThrough(league, results, Math.max(last, 0))
        .map((r) => Object.assign(r, { key: `${league.slug}:${r.id}` })));
      rows.sort((a, b) => b.pct - a.pct || b.pf - a.pf);
      if (week >= BUBBLE_FROM_WEEK && week <= LAST_REGULAR_WEEK && last >= 1) markBubble(all.map((e) => e.league), rows);
      return new Map(rows.map((r, i) => [r.key, Object.assign(r, { rank: last < 1 ? null : i + 1 })]));
    } catch (err) {
      console.warn('Overall standings unavailable', err);
      return new Map();
    }
  }

  // Bubble Spotlight: from Week 9 through the regular season, a game between two teams that are each within
  // 2 games of their league's playoff line going into the week. A team in a playoff spot is measured against the
  // first team out; a team outside, against the last team in. Games back = (wins gap + losses gap) / 2, a tie
  // counting half a win and half a loss.
  const BUBBLE_FROM_WEEK = 9;
  const BUBBLE_GAMES = 2;
  function markBubble(leagues, rows) {
    for (const league of leagues) {
      const spots = league.playoffTeams;
      const mine = rows.filter((r) => r.key.startsWith(`${league.slug}:`)); // already in standings order
      if (!spots || mine.length <= spots) continue;
      const wl = (r) => ({ w: r.record.wins + r.record.ties / 2, l: r.record.losses + r.record.ties / 2 });
      const lastIn = wl(mine[spots - 1]);
      const firstOut = wl(mine[spots]);
      mine.forEach((r, i) => {
        const me = wl(r);
        const gap = i < spots ? (me.w - firstOut.w + firstOut.l - me.l) / 2 : (lastIn.w - me.w + me.l - lastIn.l) / 2;
        r.bubble = { inside: i < spots, gap, place: i + 1 };
      });
    }
  }
  const gamesText = (n) => `${n % 1 ? n.toFixed(1) : n} game${n === 1 ? '' : 's'}`;

  // The tags that hang from a card's top-right edge: Bubble Spotlight and Top-10.
  function cardTags(keyA, keyB, overall) {
    const A = overall.get(keyA) || {}, B = overall.get(keyB) || {};
    const tags = [];
    const onBubble = (x) => x.bubble && x.bubble.gap <= BUBBLE_GAMES;
    if (onBubble(A) && onBubble(B)) {
      const say = (x) => `#${x.bubble.place}, ${x.bubble.gap === 0 ? 'right on the line' : `${gamesText(x.bubble.gap)} ${x.bubble.inside ? 'ahead of the first team out' : 'behind the last playoff spot'}`}`;
      tags.push(`<div class="bubble-tag" title="Both teams within ${BUBBLE_GAMES} games of the playoff line: ${say(A)}; ${say(B)}">Bubble<span class="long"> Spotlight</span></div>`);
    }
    if (A.rank && B.rank && A.rank <= 10 && B.rank <= 10) {
      tags.push(`<div class="top-ten" title="Both teams in the overall top 10: #${Math.min(A.rank, B.rank)} and #${Math.max(A.rank, B.rank)}">Top-10</div>`);
    }
    return tags.length ? `<div class="card-tags">${tags.join('')}</div>` : '';
  }

  // Links from This Week name a game: bring it into view below the sticky header and outline it.
  function focusGame(id) {
    if (!id) return;
    const card = document.querySelector(`.matchup[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const header = document.querySelector('.site-header');
    window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - header.offsetHeight - 12);
    card.classList.add('linked');
  }

  function bindToggles(root) {
    root.querySelectorAll('.toggle').forEach((btn) => btn.addEventListener('click', () => {
      const panel = btn.closest('.matchup').querySelector('.lineups');
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open);
      btn.querySelector('span').textContent = open ? 'Hide lineups' : 'Show lineups';
      panel.hidden = !open;
    }));
  }

  // Each team's rank and record going into a week, so a week's cards and pick never change
  // afterward. Later weeks use the latest standings. Week 1 has records but no ranks yet.
  function standingsGoingInto(league, results, week) {
    if (week === 1) return new Map(league.teams.map((t) => [t.id, { wins: 0, losses: 0, ties: 0 }]));
    if (!results) return null;
    const { weeks, ranks, records } = weeklyRanks(league, results);
    const i = Math.min(week - 1, weeks.length) - 1;
    if (i < 0) return null;
    return new Map(league.teams.map((t) => [t.id, Object.assign({ rank: ranks.get(t.id)[i] }, records.get(t.id)[i])]));
  }

  // Matchup of the week: the best combined rank in the standings, then the game with the
  // higher-ranked team.
  function pickTopRanked(games, rank) {
    const score = (g) => [rank(g.home) + rank(g.away), Math.min(rank(g.home), rank(g.away))];
    if (!games.length) return null;
    return games.reduce((a, b) => {
      const [sa, ba] = score(a);
      const [sb, bb] = score(b);
      return sa < sb || (sa === sb && ba <= bb) ? a : b;
    }).id;
  }

  function pickClosest(data) {
    const games = data.games.filter((g) => !g.bye);
    if (!games.length) return null;
    if (games.every((g) => g.decided)) {
      const g = games.reduce((a, b) => Math.abs(a.home.score - a.away.score) <= Math.abs(b.home.score - b.away.score) ? a : b);
      return { id: g.id, label: `Closest finish of week ${data.week} — decided by ${f2(Math.abs(g.home.score - g.away.score))}` };
    }
    const g = games.reduce((a, b) => Math.abs(a.prob - 0.5) <= Math.abs(b.prob - 0.5) ? a : b);
    return { id: g.id, label: data.started || games.some((x) => x.started) ? 'Closest matchup on the board right now' : 'Closest projected matchup of the week' };
  }

  async function renderMatchups(league, body, params, token, keepOpen) {
    const asked = Number(params.get('week'));
    if (ARCHIVE && PLAYOFF_ROUND_NAMES[asked] && asked < 17) {
      await renderPlayoffMatchups(league, body, asked, token, params);
      return;
    }
    const week = clampWeek(league, params.get('week'));
    const [data, results, overall] = await Promise.all([
      ESPN.getMatchups(league, week),
      ESPN.getResults(league).catch((err) => { console.warn('Past results unavailable', err); return null; }),
      overallGoingInto(week),
    ]);
    if (token !== renderToken) return;

    const openIds = keepOpen || new Set();
    const closest = pickClosest(data);
    const going = standingsGoingInto(league, results, week);
    // No standings yet (Week 1): the closest game takes the tag.
    const top = going && week > 1
      ? pickTopRanked(data.games.filter((g) => !g.bye), (side) => going.get(side.team.id).rank)
      : closest && closest.id;
    const place = (g) => (g.id === top ? 0 : closest && g.id === closest.id ? 1 : g.bye ? 3 : 2);
    const ordered = data.games.slice().sort((a, b) => place(a) - place(b));

    const cards = ordered.map((g, i) => {
      const card = matchupCard(g, league, g.id === top, closest && g.id === closest.id ? closest.label : null, openIds, going, overall);
      return i === 1 && top != null ? `<h2 class="section-label">The rest of the slate</h2>${card}` : card;
    }).join('');

    body().innerHTML = `
      <div class="matchups-bar">
        <p class="muted">${data.upcoming ? 'Upcoming matchups — lineups appear once the week begins.' : data.isCurrent ? 'Live scores and projections. Refreshes every minute.' : 'Final scores.'}</p>
        <label class="select">
          <span class="sr-only">Choose week</span>
          <select id="week-select">${weekOptions(league, week)}${ARCHIVE ? playoffWeekOptions([15, 16], week) : ''}</select>
        </label>
      </div>
      <div class="matchup-list">${cards || '<div class="state">No matchups scheduled this week.</div>'}</div>`;

    body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/${league.slug}/matchups?week=${e.target.value}`;
    });
    bindToggles(body());
    attachPicks(body(), week, data.games.filter((g) => !g.bye && g.home && g.away).map((g) => {
      const a = pickSide(g.home, league), b = pickSide(g.away, league);
      const double = Boolean(going && week > 1 && g.id === top); // Matchup of the Week (not Week 1's closest game)
      return { el: body().querySelector(`.matchup[data-id="${g.id}"]`), a, b, double, winner: pickResult(g, a, b) };
    }));
    // A recap links by team: find that team's game this week
    const teamId = params.get('team');
    const teamGame = teamId && data.games.find((g) => !g.bye && [g.home, g.away].some((s) => s && s.team && String(s.team.id) === teamId));
    if (!keepOpen) focusGame(params.get('game') || (teamGame && String(teamGame.id)));

    if (data.isCurrent && LIVE_REFRESH_MS) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async function tick() {
        if (token !== renderToken) return;
        if (document.hidden) { refreshTimer = setTimeout(tick, LIVE_REFRESH_MS); return; }
        const open = new Set([...document.querySelectorAll('.matchup .toggle[aria-expanded="true"]')]
          .map((b) => Number(b.closest('.matchup').dataset.id)));
        const y = window.scrollY;
        try {
          await renderMatchups(league, body, params, token, open);
          window.scrollTo(0, y);
        } catch (err) {
          console.warn('Live refresh failed', err);
          refreshTimer = setTimeout(tick, LIVE_REFRESH_MS);
        }
      }, LIVE_REFRESH_MS);
    }
  }

  // ---------- a past season's playoff games ----------
  // The league's bracket (playoffs.json) has each game and its score; ESPN's saved rosters have the lineups.
  const PLAYOFF_ROUND_NAMES = { 15: 'Round 1', 16: 'Round 2', 17: 'Finals' };
  let playoffFile = null;
  function seasonPlayoffs() {
    if (!playoffFile) {
      playoffFile = fetch(`${DATA}playoffs.json`).then((r) => (r.ok ? r.json() : null));
      playoffFile.catch(() => { playoffFile = null; });
    }
    return playoffFile;
  }
  const playoffWeekOptions = (weeks, selected) => weeks.map((w) =>
    `<option value="${w}" ${w === selected ? 'selected' : ''}>${PLAYOFF_ROUND_NAMES[w]} · Week ${w}</option>`).join('');
  // A game's id is its place in playoffs.json, so the Playoffs and Toilet Bowl tabs can link to it.
  const playoffGameId = (i) => `g${i}`;
  const playoffGameLink = (g, i) => (g.league
    ? `#/${g.league}/matchups?week=${g.week}&game=${playoffGameId(i)}`
    : `#/cross-league?week=17&game=${playoffGameId(i)}`);
  const sinksGame = (g) => /Losers|Ultimate Loser|Toilet Bowl/.test(g.title); // the lower score moves on

  // Each owner's team, league and lineup for a playoff week.
  async function playoffSides(leagues, week) {
    const rosters = await Promise.all(leagues.map((l) => ESPN.getRosters(l, week)));
    const sides = new Map();
    leagues.forEach((l, i) => {
      for (const team of l.teams) sides.set(team.owner, { team, league: l, lineup: rosters[i].byTeam.get(team.id) || null, week });
    });
    return sides;
  }

  function playoffGame(g, id, sides) {
    const [home, away] = g.teams.map((s) => Object.assign({}, sides.get(s.owner), { score: s.score, proj: null, seed: s.seed }));
    const winner = home.score >= away.score ? 'home' : 'away';
    return { id, home, away, decided: true, winner, prob: winner === 'home' ? 1 : 0, playoffTitle: g.title, sinks: sinksGame(g), league: g.league };
  }

  function playoffLabel(g, prefix = '') {
    const note = g.playoffTitle === 'Losers Final' ? ' · lower score goes to the Toilet Bowl Final'
      : /Losers/.test(g.playoffTitle) ? ' · lower score moves on'
        : g.playoffTitle === 'Ultimate Loser' ? ' · lower score is the Ultimate Loser'
        : g.playoffTitle === 'Toilet Bowl' && g.league ? ' · lower score goes to the Toilet Bowl Final' : '';
    return `<h2 class="section-label">${esc(prefix)}${esc(g.playoffTitle)}${note}</h2>`;
  }

  async function renderPlayoffMatchups(league, body, week, token, params) {
    const [file, sides] = await Promise.all([seasonPlayoffs(), playoffSides([league], week)]);
    if (token !== renderToken) return;
    // Seeds and records are the official regular-season ones.
    const going = new Map(league.teams.map((t, i) => [t.id, { wins: t.wins, losses: t.losses, ties: t.ties || 0, rank: i + 1 }]));
    const leagueName = (LEAGUES.find((l) => l.slug === league.slug) || league).name;
    const games = file.games.map((g, i) => [g, i]).filter(([g]) => g.league === league.slug && g.week === week)
      .map(([g, i]) => (g.teams.length > 2
        // 2025 on: a three-team Wildcard and league Championship, top score moving on
        ? { many: true, id: playoffGameId(i), week, title: g.title, sinks: sinksGame(g),
          playoffTitle: `${g.title === 'Championship' ? `${leagueName} ` : ''}${g.title} · top score ${g.title === 'Championship' ? 'goes to the Champions Cup' : 'moves on'}`,
          teams: g.teams.map((s) => Object.assign({}, sides.get(s.owner), { score: s.score, seed: s.seed })) }
        : playoffGame(g, playoffGameId(i), sides)));
    const cards = games.map((g) => (g.many
      ? fourTeamCard(g, new Map(), { place: () => '', badge: (s) => `<span class="seed" title="Seed">#${s.seed}</span>`, record: (s) => going.get(s.team.id) })
      : playoffLabel(g, g.playoffTitle === 'Championship' ? `${leagueName} ` : '')
        + matchupCard(g, league, false, null, new Set(), going, new Map()))).join('');
    body().innerHTML = `
      <div class="matchups-bar">
        <p class="muted">${PLAYOFF_ROUND_NAMES[week]} of the playoffs, from the league's bracket. Numbers are regular-season seeds.</p>
        <label class="select">
          <span class="sr-only">Choose week</span>
          <select id="week-select">${weekOptions(league, week)}${playoffWeekOptions([15, 16], week)}</select>
        </label>
      </div>
      <div class="matchup-list">${cards}</div>`;
    body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/${league.slug}/matchups?week=${e.target.value}`;
    });
    bindToggles(body());
    focusGame(params.get('game'));
  }

  // Cross-League's Finals: the placement games between the leagues (week 17, plus Round 1's 9th place final).
  async function renderCrossFinals(body, token, weeks, params) {
    const leagues = await loadAllLeagues();
    const file = await seasonPlayoffs();
    const between = file.games.map((g, i) => [g, i]).filter(([g]) => !g.league);
    const finalWeeks = [...new Set(between.map(([g]) => g.week))];
    const [standings, ...sideList] = await Promise.all([lockedStandings(), ...finalWeeks.map((w) => playoffSides(leagues, w))]);
    if (token !== renderToken) return;
    const sidesIn = new Map(finalWeeks.map((w, k) => [w, sideList[k]]));
    const { out, ranks } = lockedCrossData(standings);
    const overall = new Map();
    for (const cfg of LEAGUES) {
      for (const t of standings.leagues[cfg.slug].teams) {
        const tally = (wins, losses, ties) => ({ wins, losses, ties: ties || 0 });
        overall.set(`${cfg.slug}:${t.id}`, {
          record: tally(t.wins, t.losses, t.ties), inLeague: tally(t.inW, t.inL, t.inT), cross: tally(t.xW, t.xL, t.xT), rank: ranks.get(`${cfg.slug}:${t.id}`),
        });
      }
    }
    const teamCount = LEAGUES.reduce((n, cfg) => n + standings.leagues[cfg.slug].teams.length, 0);
    const place = (g) => (g.title === 'Championship' ? 1 : g.title === 'Toilet Bowl' ? teamCount - g.teams.length + 1 : parseInt(g.title, 10) || 50);
    const nameOf = (g) => g.name || (g.title === 'Championship' ? 'Grand Championship' : g.title);
    const leagueOrder = (sides) => (a, b) => LEAGUES.findIndex((l) => l.slug === sides.get(a.owner).league.slug)
      - LEAGUES.findIndex((l) => l.slug === sides.get(b.owner).league.slug);
    const finals = between.map(([g, i]) => {
      const sides = sidesIn.get(g.week);
      const titled = nameOf(g) + (g.week === 17 ? '' : ` · Week ${g.week}`);
      if (g.teams.length > 2) {
        return { four: true, id: playoffGameId(i), week: g.week, place: place(g), bracket: g.bracket, title: g.title, playoffTitle: titled,
          teams: g.teams.map((s) => Object.assign({}, sides.get(s.owner), { score: s.score })) };
      }
      // Lab Rats on the left, as in the weekly cross-league games.
      const teams = g.teams.slice().sort(leagueOrder(sides));
      return Object.assign(playoffGame({ ...g, teams }, playoffGameId(i), sides), { week: g.week, place: place(g), bracket: g.bracket, playoffTitle: titled });
    });
    const card = (g) => (g.four ? fourTeamCard(g, overall) : playoffLabel(g) + crossCard(g, out, ranks, new Set(), overall, false, null));
    const section = (title, list) => `<h2 class="section-label xl-finals-head">${esc(title)}</h2>${list.map(card).join('')}`;
    const ups = finals.filter((g) => g.bracket !== 'toilet').sort((a, b) => a.place - b.place);
    const downs = finals.filter((g) => g.bracket === 'toilet').sort((a, b) => b.place - a.place);
    const cup = ups.find((g) => g.title === 'Championship');
    const bowl = downs.find((g) => g.title === 'Toilet Bowl');
    const options = weeks.map((w) => `<option value="${w}">Week ${w}</option>`).join('') + playoffWeekOptions([17], 17);
    body().innerHTML = `
      <div class="matchups-bar">
        <p class="muted">The final round between the leagues, from the league's bracket. Numbers are overall regular-season ranks.${cup && cup.four ? ' Each final ranks its four teams by score, one team from each league.' : ''}</p>
        <label class="select">
          <span class="sr-only">Choose week</span>
          <select id="week-select">${options}</select>
        </label>
      </div>
      <div class="matchup-list">
        ${section(`${cup && cup.four ? 'Champions Cup' : 'Championship'} and placement finals`, ups)}
        ${section(`${bowl && bowl.four ? 'Toilet Bowl Final' : 'Toilet Bowl'} and placement finals`, downs)}
      </div>`;
    body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/cross-league?week=${e.target.value}`;
    });
    bindToggles(body());
    focusGame(params.get('game'));
  }

  // A four-team final: its teams by score, each with the place it finished. The top score is marked, except in
  // the Toilet Bowl Final, where the lowest score (the Ultimate Loser) is.
  // opts (a league's three-team games): place(k) labels a row, badge(side) and record(side) replace the overall rank and record.
  function fourTeamCard(g, overall, opts = {}) {
    const ranked = g.teams.slice().sort((a, b) => b.score - a.score);
    const bowl = g.title === 'Toilet Bowl';
    const marked = bowl ? ranked[ranked.length - 1] : ranked[0];
    const cls = g.title === 'Championship' ? 'xf-cup' : bowl ? 'xf-bowl' : '';
    const row = (s, k) => {
      const key = `${s.league.slug}:${s.team.id}`;
      const asOf = opts.record ? { record: opts.record(s), inLeague: null } : overall.get(key);
      const href = `#/${s.league.slug}/rosters?team=${s.team.id}&week=${s.week}`;
      const label = opts.place ? opts.place(k) : ordinal(g.place + k);
      return `
        <div class="xf-row ${s === marked ? 'marked' : ''}" style="--accent:var(--${s.league.theme})">
          <span class="xf-place" ${opts.place ? '' : `title="Finished ${label} overall"`}>${label}</span>
          ${teamLogo(s.team, s.league, 'avatar')}
          <div class="side-id">
            <span class="xl-badges">${opts.badge ? opts.badge(s) : `${asOf && asOf.rank ? `<span class="seed" title="Overall rank">#${asOf.rank}</span>` : ''}${leagueChip(s.league)}`}</span>
            <a class="side-name" href="${href}">${esc(s.team.name)}</a>
            <span class="side-owner">${esc(s.team.owner)}${asOf ? ` · <span ${asOf.inLeague ? `title="In-league ${record(asOf.inLeague)} · Cross-league ${record(asOf.cross)}"` : ''}>${record(asOf.record)}</span>` : ''}</span>
          </div>
          <span class="score">${f2(s.score)}</span>
        </div>`;
    };
    const icon = g.title === 'Championship' ? 'grand-champion' : bowl ? 'ultimate-loser' : '';
    return `
      <article class="matchup cross xf ${cls}" data-id="${g.id}">
        <h3 class="xf-title">${icon ? `<img src="assets/img/champs/${icon}.png" alt="" width="26" height="26">` : ''}${esc(g.playoffTitle)}</h3>
        <div class="xf-rows">${ranked.map(row).join('')}</div>
        <p class="prob-label">Final</p>
        ${lineupToggle(g, new Set(), ranked.map((s) => lineupColumn(s, s.league)).join(''), 'xf-lineups')}
      </article>`;
  }

  // ---------- cross-league ----------
  // Pairings come from the Google Sheet (by owner first name); everything else from ESPN.
  // All 36 teams in overall order (Home standings): [{ team, league, rank }].
  function rankAllTeams(o) {
    // Work on copies: the cached league objects are shared with other pages.
    const leagues = o.leagues.map((l) => {
      const copy = Object.assign({}, l, { teams: l.teams.map((t) => Object.assign({}, t)) });
      applyOverall(copy, o.out);
      return copy;
    });
    const entries = leagues.flatMap((l) => l.teams.map((t) => ({ team: t, league: l })));
    entries.sort((a, b) => b.team.pct - a.team.pct || b.team.pf - a.team.pf);
    entries.forEach((e, i) => { e.rank = i + 1; });
    return entries;
  }

  function crossRecordText(team, cross) {
    const c = cross || { w: 0, l: 0, t: 0 };
    const w = team.wins + c.w, l = team.losses + c.l, t = (team.ties || 0) + c.t;
    return {
      text: `${w}-${l}${t ? `-${t}` : ''}`,
      title: `In-league ${record(team)} · Cross-league ${c.w}-${c.l}${c.t ? `-${c.t}` : ''}`,
    };
  }

  function leagueChip(league) {
    const name = esc(league.displayName || league.name);
    return `<span class="lchip" style="--c:var(--${league.theme})" title="${name}"><i class="dot"></i><span class="lchip-name">${name}</span></span>`;
  }

  function crossCard(g, records, ranks, openIds, overall, top, closest) {
    const pHome = Math.round(g.prob * 100);
    const homeLead = g.decided ? g.winner === 'home' : g.prob > 0.5;
    const awayLead = g.decided ? g.winner === 'away' : g.prob < 0.5;
    const side = (s, align, lead) => {
      if (s.median) {
        return `
          <div class="side ${align} ${lead ? 'leading' : ''}">
            <div class="side-id"><span class="side-name">Weekly median</span><span class="side-owner">Bye-week opponent</span></div>
            <img class="avatar lg" src="assets/img/mgdx-seal.png?v=2" alt="">
            <div class="side-score"><span class="score">${f2(s.score)}</span></div>
          </div>`;
      }
      if (s.missing) {
        return `<div class="side ${align}"><div class="side-id"><span class="side-name">${esc(s.team.name)}</span><span class="side-owner">Not found in ESPN</span></div></div>`;
      }
      const key = `${s.league.slug}:${s.team.id}`;
      const asOf = overall.get(key);
      const r = asOf
        ? { text: record(asOf.record), title: `In-league ${record(asOf.inLeague)} · Cross-league ${record(asOf.cross)}` }
        : crossRecordText(s.team, records.get(key));
      const rank = asOf ? asOf.rank : ranks.get(key);
      return sideHead(s, s.league, align, lead, {
        badge: `<span class="xl-badges">${rank ? `<span class="seed" title="Overall rank">#${rank}</span>` : ''}${leagueChip(s.league)}</span>`,
        rec: r.text, recTitle: r.title, style: `--accent:var(--${s.league.theme})`,
      });
    };
    const hasLineups = (g.home.lineup || g.away.lineup) && !g.home.missing && !g.away.missing;
    return `
      <article class="matchup cross ${top ? 'featured' : ''}" data-id="${g.id}" style="--home-c:var(--${g.home.league.theme});--away-c:var(--${g.away.league.theme})">
        ${top ? `<div class="flag">Matchup of the week</div>` : ''}
        ${cardTags(`${g.home.league.slug}:${g.home.team.id}`, `${g.away.league.slug}:${g.away.team.id}`, overall)}
        <div class="matchup-head">
          ${side(g.home, 'left', homeLead)}
          <span class="vs-mark">vs</span>
          ${side(g.away, 'right', awayLead)}
        </div>
        <div class="prob" role="img" aria-label="Win probability: ${esc(g.home.team.name)} ${pHome}%, ${esc(g.away.team.name)} ${100 - pHome}%">
          <span class="pct ${homeLead ? 'lead' : ''}">${pHome}%</span>
          <div class="bar"><i style="width:${pHome}%"></i></div>
          <span class="pct ${awayLead ? 'lead' : ''}">${100 - pHome}%</span>
        </div>
        <p class="prob-label">${g.decided ? 'Final' : g.upcoming ? 'Upcoming' : 'Win probability'}</p>
        ${closest ? `<div class="banner"><span>${esc(closest)}</span></div>` : ''}
        ${hasLineups ? lineupToggle(g, openIds, lineupColumn(g.home, g.home.league) + lineupColumn(g.away, g.away.league)) : ''}
      </article>`;
  }

  function crossShell() {
    return `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-seal.png?v=2" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow">Microgen Fantasy Football · ${SEASON}</p>
          <h1 class="page-title">Cross-League</h1>
          <p class="hero-dots">${LEAGUES.map((l) => `<span><i class="dot" style="--c:var(--${l.theme})"></i>${esc(l.name)}</span>`).join('')}</p>
        </div>
      </section>
      <div id="league-body">${loading()}</div>`;
  }

  // Sections open for this visit. They stay open through live refreshes and start closed otherwise.
  let crossOpen = new Set();

  async function renderCrossLeague(params, keepOpen) {
    const token = keepOpen ? renderToken : ++renderToken;
    const body = () => document.getElementById('league-body');
    if (!keepOpen) {
      document.body.dataset.theme = 'home';
      document.title = 'Cross-League · Microgen Fantasy Football';
      main.innerHTML = crossShell();
    }
    try {
      const leagues = await loadAllLeagues();
      if (token !== renderToken) return;
      const currentWeek = Math.max(...leagues.map((l) => l.currentWeek));
      const weeks = SHEET.weeks;
      if (ARCHIVE && Number(params.get('week')) === 17) {
        await renderCrossFinals(body, token, weeks, params);
        return;
      }
      let week = Number(params.get('week')) || currentWeek;
      if (!weeks.includes(week)) week = weeks.reduce((a, b) => (Math.abs(b - week) < Math.abs(a - week) ? b : a));

      const [sheet, weekData, records, overall] = await Promise.all([
        SHEET.getWeek(week),
        Promise.all(leagues.map((l) => ESPN.getMatchups(l, week))),
        lockedStandings().then(async (file) => {
          if (file) return lockedCrossData(file);
          const o = await overallRecords();
          return { out: o.out, ranks: new Map(rankAllTeams(o).map((e) => [`${e.league.slug}:${e.team.id}`, e.rank])) };
        }),
        overallGoingInto(week),
      ]);
      if (token !== renderToken) return;
      const { out: crossOut, ranks } = records;

      // ESPN side (score, projection, lineup) for every team this week.
      const sides = new Map();
      const byeTeams = [];
      leagues.forEach((l, i) => {
        for (const g of weekData[i].games) {
          for (const s of [g.home, g.away]) if (s) sides.set(`${l.slug}:${s.team.id}`, Object.assign({}, s, { league: l, week }));
          if (g.bye) byeTeams.push({ league: l, team: g.home.team });
        }
      });

      const decided = week < currentWeek;
      const upcoming = week > currentWeek;
      const sections = resolveWeek(sheet, leagues, byeTeams).map((sec, si) => ({
        ...sec,
        games: sec.games.map(([a, b], gi) => {
          const toSide = (x) => {
            const side = x.missing ? Object.assign({ score: 0, proj: 0, lineup: null }, x)
              : sides.get(`${x.league.slug}:${x.team.id}`) || Object.assign({ score: 0, proj: 0, lineup: null, week }, x);
            // A saved past season shows the score the league recorded for the game.
            return x.sheet && x.sheet.score != null ? Object.assign({}, side, { score: x.sheet.score, proj: x.sheet.score }) : side;
          };
          const home = toSide(a), away = toSide(b);
          const official = a.sheet && (a.sheet.result || b.sheet.result);
          const winner = !decided ? null : official
            ? ((a.sheet.result || (b.sheet.result === 'W' ? 'L' : 'W')) === 'W' ? 'home' : 'away')
            : home.score > away.score ? 'home' : away.score > home.score ? 'away' : 'tie';
          return {
            id: `x${si}-${gi}`, home, away, decided, winner, upcoming,
            prob: ESPN.winProb(home, away, decided, winner),
          };
        }),
      }));

      // One matchup of the week and one closest matchup across every section, the matchup of the week by
      // overall rank. With no ranks yet (Week 1), the closest game takes that tag too.
      const allGames = sections.flatMap((sec) => sec.games);
      const overallRank = (side) => (overall.get(`${side.league.slug}:${side.team.id}`) || {}).rank;
      const rankedGames = allGames.filter((g) => overallRank(g.home) && overallRank(g.away));
      const started = !decided && !upcoming && allGames.some((g) => g.home.score > 0 || g.away.score > 0);
      const closestGame = pickClosest({ games: allGames.filter((g) => !g.home.missing && !g.away.missing), week, started });
      const top = rankedGames.length ? pickTopRanked(rankedGames, overallRank) : closestGame && closestGame.id;

      const place = (g) => (g.id === top ? 0 : closestGame && g.id === closestGame.id ? 1 : 2);

      const openIds = keepOpen || new Set();
      if (!keepOpen) {
        crossOpen = new Set();
        const linked = /^x(\d+)-/.exec(params.get('game') || '');
        if (linked) crossOpen.add(Number(linked[1])); // a link from This Week opens its game's section
      }
      const options = weeks.map((w) => `<option value="${w}" ${w === week ? 'selected' : ''}>Week ${w}${w === currentWeek ? ' · current' : ''}</option>`).join('')
        + (ARCHIVE ? playoffWeekOptions([17], week) : '');
      const html = sections.map((sec, si) => {
        const names = sec.bye
          ? '<span>Bye-week matchups</span>'
          : sec.leagues.map((l, i) => (l
            ? `<span><img class="xl-logo" src="${LEAGUES.find((c) => c.slug === l.slug).badge}" alt="" width="28" height="28">${esc(l.displayName)}</span>`
            : `<span>${esc(sec.names[i])}</span>`)).join('<em>vs.</em>');
        const open = crossOpen.has(si);
        const paired = !sec.bye && sec.leagues.every(Boolean);
        const hideLabel = sec.bye ? 'Hide bye-week matchups' : paired
          ? `Hide ${sec.leagues.map((l) => `<i class="dot" style="--c:var(--${l.theme})"></i>`).join(' vs. ')} matchups`
          : 'Hide matchups';
        const hideName = paired ? `Hide ${sec.leagues.map((l) => esc(l.displayName)).join(' vs. ')} matchups` : '';
        return `
          <section class="panel xl-section" data-sec="${si}">
            <h2 class="xl-head">
              <button class="xl-toggle" type="button" aria-expanded="${open}" aria-controls="xl-${si}">
                <span class="xl-names">${names}</span>
                <span class="xl-view"><span>${open ? 'Hide matchups' : 'View matchups'}</span><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              </button>
            </h2>
            <div class="xl-games" id="xl-${si}" ${open ? '' : 'hidden'}>${sec.games.slice().sort((a, b) => place(a) - place(b)).map((g) => crossCard(g, crossOut, ranks, openIds, overall, g.id === top, closestGame && g.id === closestGame.id ? closestGame.label : null)).join('')}
              <button class="xl-hide" type="button" ${hideName ? `aria-label="${hideName}"` : ''}><span>${hideLabel}</span><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </section>`;
      }).join('');

      body().innerHTML = `
        <div class="matchups-bar">
          <p class="muted">${upcoming ? 'Upcoming cross-league matchups.' : ARCHIVE ? `Final scores as the league recorded them${ARCHIVE.medianByes ? `; in ${SEASON}, a team on bye played the week's median` : ''}.` : decided ? 'Final scores.' : 'Live scores and projections. Refreshes every minute.'} Records include in-league and cross-league games.</p>
          <label class="select">
            <span class="sr-only">Choose week</span>
            <select id="week-select">${options}</select>
          </label>
        </div>
        <div class="matchup-list">${html || '<div class="state">No cross-league matchups found for this week.</div>'}</div>`;

      body().querySelector('#week-select').addEventListener('change', (e) => {
        location.hash = `#/cross-league?week=${e.target.value}`;
      });
      bindToggles(body());
      attachPicks(body(), week, allGames.filter((g) => !g.home.missing && !g.away.missing && !g.home.median && !g.away.median).map((g) => {
        const a = pickSide(g.home, g.home.league), b = pickSide(g.away, g.away.league);
        const double = rankedGames.length > 0 && g.id === top; // Matchup of the Week (not Week 1's closest game)
        return { el: body().querySelector(`.matchup[data-id="${g.id}"]`), a, b, cross: true, double, winner: pickResult(g, a, b) };
      }));
      const setSection = (section, open) => {
        const si = Number(section.dataset.sec);
        const btn = section.querySelector('.xl-toggle');
        if (open) crossOpen.add(si);
        else crossOpen.delete(si);
        btn.setAttribute('aria-expanded', open);
        btn.querySelector('.xl-view span').textContent = open ? 'Hide matchups' : 'View matchups';
        document.getElementById(`xl-${si}`).hidden = !open;
      };
      body().querySelectorAll('.xl-toggle').forEach((btn) => btn.addEventListener('click', () => {
        setSection(btn.closest('.xl-section'), btn.getAttribute('aria-expanded') !== 'true');
      }));
      // Closing from the bottom removes everything above the button, so bring the section's bar back into view.
      body().querySelectorAll('.xl-hide').forEach((btn) => btn.addEventListener('click', () => {
        const section = btn.closest('.xl-section');
        setSection(section, false);
        const top = document.querySelector('.site-header').offsetHeight + 12;
        if (section.getBoundingClientRect().top < top) window.scrollBy(0, section.getBoundingClientRect().top - top);
        section.querySelector('.xl-toggle').focus({ preventScroll: true });
      }));
      if (!keepOpen) focusGame(params.get('game'));

      if (!decided && !upcoming && LIVE_REFRESH_MS) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async function tick() {
          if (token !== renderToken) return;
          if (document.hidden) { refreshTimer = setTimeout(tick, LIVE_REFRESH_MS); return; }
          const open = new Set([...document.querySelectorAll('.matchup .toggle[aria-expanded="true"]')]
            .map((b) => b.closest('.matchup').dataset.id));
          const y = window.scrollY;
          await renderCrossLeague(params, open);
          window.scrollTo(0, y);
        }, LIVE_REFRESH_MS);
      }
    } catch (err) {
      if (token !== renderToken) return;
      console.error(err);
      body().innerHTML = errorBox(err, location.hash);
    }
  }

  // ---------- router ----------
  function route() {
    clearTimeout(refreshTimer);
    const { parts, params } = parseHash();
    const key = parts[0];
    const cfg = LEAGUES.find((l) => l.slug === key);
    if (cfg) {
      const sub = SUBTABS.includes(parts[1]) ? parts[1] : SUBTABS[0];
      setActiveNav(cfg.slug);
      renderLeague(cfg, sub, params);
    } else if (key === 'cross-league') {
      setActiveNav('cross-league');
      renderCrossLeague(params);
    } else if (key === 'blog') {
      renderToken++;
      setActiveNav('blog');
      if (parts[1] === 'bets') { history.replaceState(null, '', '#/blog/predictions'); return route(); } // the tab's old name
      renderBlog(BLOG_TABS.includes(parts[1]) ? parts[1] : 'main', params);
    } else if (key === 'archives') {
      renderToken++;
      setActiveNav('archives');
      renderArchives(ARCHIVE_TABS.includes(parts[1]) || parts[1] === 'manager' ? parts[1] : 'records', params);
    } else if (key === 'account' && ACCOUNT && !ARCHIVE) {
      setActiveNav('');
      renderAccount();
    } else if (PLACEHOLDERS[key]) {
      renderToken++;
      setActiveNav(key);
      renderPlaceholder(key);
    } else {
      setActiveNav('home');
      renderHome(HOME_TABS.includes(parts[1]) ? parts[1] : HOME_TABS[0], params);
    }
  }

  let lastLeagueKey = '';
  window.addEventListener('hashchange', () => {
    const key = parseHash().parts.slice(0, 2).join('/');
    // Only jump to top when moving to a different page, not when changing week/team.
    if (key !== lastLeagueKey) window.scrollTo(0, 0);
    lastLeagueKey = key;
    route();
  });
  lastLeagueKey = parseHash().parts.slice(0, 2).join('/');
  // Custom logos: with the list this device saved last time, draw at once and redraw only if it changed.
  // On a first visit, wait for them (up to 1.5s) so the first page doesn't flash ESPN's; if they come later,
  // the page redraws. A logo changed on this device redraws too.
  if (ACCOUNT && ACCOUNT.enabled && !ARCHIVE && ACCOUNT.logosCached) {
    route();
    ACCOUNT.logosReady.then((changed) => { if (changed) route(); });
    ACCOUNT.onLogosChange(route);
  } else if (ACCOUNT && ACCOUNT.enabled && !ARCHIVE) {
    let first = true;
    const late = ACCOUNT.logosReady.then((changed) => { if (!first && changed) route(); });
    Promise.race([late, new Promise((r) => setTimeout(r, 1500))]).then(() => { first = false; route(); });
    ACCOUNT.onLogosChange(route);
  } else route();
})();
