// Router + views. Routes: #/home, #/<league>/<standings|rosters|matchups>?team=&week=
(function () {
  const { LEAGUES, LIVE_REFRESH_MS, SEASON } = window.MGDX;
  const { loadAllLeagues, resolveWeek, overallRecords, crossSchedules, applyOverall } = window.SEASON_DATA;
  const main = document.getElementById('main');
  const PLACEHOLDERS = {
    blog: { title: 'Blog', kicker: 'Takes, recaps and trash talk', art: 'assets/img/mgdx-shield.png?v=3' },
    archives: { title: 'Archives', kicker: 'Seasons past', art: 'assets/img/mgdx-shield.png?v=3' },
  };
  const SUBTABS = ['standings', 'rosters', 'matchups', 'power-rankings', 'transactions', 'draft-board'];
  const subtabLabel = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  let refreshTimer = null;
  let renderToken = 0;
  let scheduleOpen = false; // Rosters season schedule stays open when switching team or week
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

  function teamLogo(team, league, cls = 'avatar') {
    const fallback = league.logo;
    const src = team && team.logo ? team.logo : fallback;
    return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${esc(fallback)}'">`;
  }

  // Small logos by a former champion's name: a golden goat per grand championship, then a league logo per title.
  function champBadges(team) {
    const goats = Array.from({ length: team.grandTitles || 0 }, () =>
      '<img class="champ goat" src="assets/img/champs/grand-champion.png" alt="Grand champion" title="Grand champion" width="17" height="17">');
    const logos = (team.titles || []).map((slug) => {
      const l = LEAGUES.find((x) => x.slug === slug);
      if (!l) return '';
      const label = `${esc(l.name)} champion`;
      return `<img class="champ" src="${l.badge}" alt="${label}" title="${label}" width="17" height="17">`;
    });
    const all = goats.concat(logos).join('');
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
      <nav class="subtabs" aria-label="${esc(league.name)} sections">
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
        p: fetch('data/standings.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
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
      const { name, owner, logo, titles, grandTitles, ...records } = s;
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
      byTeam.set(key, team.crossSchedule.map(([week, opp]) => ({ week, opp: teams.get(opp) })));
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
      + '<section class="panel rank-chart" id="rank-chart"></section>';
    drawRankChart(document.getElementById('rank-chart'), weeklyRanks(league, results));
  }

  // Each team's rank after every completed week, by the standings rule at that point in the
  // season: overall win % (in-league + cross-league), then PF (each week's score, byes included).
  function weeklyRanks(league, results) {
    const weeks = [];
    for (let w = 1; w < league.currentWeek; w++) weeks.push(w);
    const teams = league.teams.slice().sort((a, b) => a.id - b.id); // color follows the team, not its rank
    const ranks = new Map(teams.map((t) => [t.id, []]));
    for (const w of weeks) {
      const table = teams.map((t) => {
        const own = (results.get(t.id) || []).filter((r) => r.week <= w);
        const games = own.filter((r) => r.result).concat((t.crossGames || []).filter((g) => g.week <= w));
        const won = games.filter((g) => g.result === 'W').length;
        const tied = games.filter((g) => g.result === 'T').length;
        const pf = own.filter((r) => r.result || r.bye).reduce((s, r) => s + r.pf, 0);
        return { id: t.id, pct: games.length ? (won + tied / 2) / games.length : 0, pf };
      }).sort((a, b) => b.pct - a.pct || b.pf - a.pf);
      table.forEach((row, i) => ranks.get(row.id).push(i + 1));
    }
    return { weeks, teams, ranks };
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
  function standingsTable(entries, opts) {
    // opts.sort: { key: 'rank'|'pf'|'pa', dir: 'desc'|'asc' } makes Overall/PF/PA headers clickable.
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
    const rows = entries.map(({ team: t, league, results, rank }, i) => {
      // Every decided game in order: in-league first, then that week's cross-league game(s).
      const games = (results || []).filter((r) => r.result)
        .concat(t.crossGames || [])
        .sort((a, b) => a.week - b.week || !!a.cross - !!b.cross);
      const recent = games.filter((g) => g.week >= firstRecentWeek && g.week < currentWeek);
      const dots = recent.map((r) => {
        const vs = r.opp ? ` vs ${r.opp.name}${r.cross ? ` (${r.oppLeague.displayName})` : ''}` : '';
        return `<i class="dot-r ${r.result}" title="Week ${r.week}${r.cross ? ' cross-league' : ''}: ${r.result} ${f2(r.pf)}–${f2(r.pa)}${esc(vs)}"></i>`;
      }).join('');
      let n = 0;
      for (let k = games.length - 1; k >= 0 && games[k].result === games[games.length - 1].result; k--) n++;
      const streak = n ? `${games[games.length - 1].result}${n}` : '';
      const line = playoffTeams && i + 1 === playoffTeams && i + 1 < entries.length
        ? `<tr class="playoff-line" aria-hidden="true"><td colspan="${cols}"><div class="pl"><span>Playoff line</span><span>Top ${playoffTeams} in</span></div></td></tr>` : '';
      const rowCls = showLeague ? 'lg-row' : i < playoffTeams ? 'in' : 'out';
      return `
        <tr class="${rowCls}" ${showLeague ? `style="--lc:var(--${league.theme})"` : ''}>
          <td class="c-rank"><span class="rank">${rank || i + 1}</span></td>
          <td class="c-team">
            <a class="team-cell" href="#/${league.slug}/rosters?team=${t.id}">
              ${teamLogo(t, league)}
              <span><strong>${esc(t.name)}</strong><small>${esc(t.owner)}${champBadges(t)}</small>${showLeague ? `<small class="lg-name">${esc(league.displayName)}</small>` : ''}</span>
            </a>
          </td>
          <td class="c-num c-rec">${record(t)}</td>
          ${overall ? `<td class="c-num hide-sm muted">${split(t.inW, t.inL, t.inT)}</td><td class="c-num hide-sm muted">${split(t.xW, t.xL, t.xT)}</td>` : ''}
          <td class="c-num hide-sm ${showLeague ? 'hide-md' : ''}">${t.pct != null ? t.pct.toFixed(3).replace(/^0/, '') : '—'}</td>
          <td class="c-last hide-xs"><span class="dots">${dots}</span><span class="streak ${streak[0] || ''}">${streak}</span></td>
          <td class="c-num" ${t.byePf ? `title="Includes ${f2(t.byePf)} from bye weeks"` : ''}>${f2(t.pf)}</td>
          <td class="c-num hide-sm muted" ${t.crossPa ? `title="In-league ${f2(t.pa - t.crossPa)} + cross-league ${f2(t.crossPa)}"` : ''}>${f2(t.pa)}</td>
        </tr>${line}`;
    }).join('');
    return `
      <div class="panel st-panel ${standingsExpanded ? 'st-expanded' : ''}">
        <button class="toggle st-expand" type="button" aria-expanded="${standingsExpanded}">${standingsExpanded ? 'Show fewer columns' : 'Show all columns'}</button>
        <p class="st-hint">Swipe the table sideways to see every column</p>
        <div class="table-wrap">
          <table class="standings">
            <thead><tr>
              <th class="c-rank">Rank</th><th>Team</th>${sortTh('rank', overall ? 'Overall' : 'Record', 'c-num', 'Sort by standings (record, then PF)')}
              ${overall ? '<th class="c-num hide-sm" title="In-league record">League</th><th class="c-num hide-sm" title="Cross-league record">Cross</th>' : ''}
              <th class="c-num hide-sm ${showLeague ? 'hide-md' : ''}">Pct</th>
              <th class="c-last hide-xs" title="In-league and cross-league games from the last 3 completed weeks">${overall ? 'Last 6' : 'Last 3'}</th>${sortTh('pf', 'PF', 'c-num')}${sortTh('pa', 'PA', 'c-num hide-sm')}
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
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
      draftFile = fetch('data/draft-boards.json?v=2').then((r) => (r.ok ? r.json() : null)).catch(() => null);
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
        <p class="draft-hint">Swipe sideways to see every team</p>
        <div class="table-wrap">
          <table class="draft">
            <thead><tr>
              <th class="dr-rd">Rd</th>
              ${board.columns.map((id) => {
                const t = board.teams[id];
                return `<th><a href="#/${league.slug}/rosters?team=${id}" title="${esc(t ? t.name : '')}">${t ? teamLogo(t, league) : ''}<span>${esc(t ? t.owner : '')}</span></a></th>`;
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
      <p class="fineprint">Draft results by round, with teams in the same order as the league's draft board.</p>`;
  }

  // Results are calculated once a week by tools/run-power-rankings.js; the page only reads the saved file.
  let lockedCache = null;
  function lockedRankings() {
    if (lockedCache && Date.now() - lockedCache.t < 300000) return lockedCache.p;
    const p = fetch('data/power-rankings.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d && d.season === SEASON ? d : null))
      .catch(() => null);
    lockedCache = { t: Date.now(), p };
    return p;
  }

  async function renderPowerRankings(league, body, token) {
    const locked = await lockedRankings();
    if (token !== renderToken) return;
    if (!locked) {
      body().innerHTML = '<div class="state"><strong>Power Rankings aren\'t available yet.</strong><span>They\'re calculated once a week, after ESPN finalizes the previous week.</span></div>';
      return;
    }
    const { odds, sims, week, calculatedAt } = locked;
    const blank = { playoffs: 0, bye: 0, title: 0 };
    const asOf = new Date(calculatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const status = week < league.currentWeek
      ? `From Week ${week}, calculated ${asOf}. This week's update is on its way.`
      : `Locked for Week ${week}. Calculated ${asOf}; next update after this week's games are final.`;
    const pct = (v) => {
      const n = v * 100;
      if (n >= 99.5) return '>99%';
      if (n < 0.5) return '<1%';
      return `${Math.round(n)}%`;
    };
    const rows = league.teams.map((team, standing) => ({ team, standing, o: odds[`${league.slug}:${team.id}`] || blank }))
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

  // ---------- home ----------
  const HOME_TABS = ['standings'];

  async function renderHome(sub) {
    const token = ++renderToken;
    document.body.dataset.theme = 'home';
    document.title = 'Home · Microgen Fantasy Football';
    main.innerHTML = `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-logo.png" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow" id="home-eyebrow">${SEASON}</p>
          <h1 class="page-title">Microgen Fantasy Football</h1>
          <p class="hero-dots">${LEAGUES.map((l) => `<span><i class="dot" style="--c:var(--${l.theme})"></i>${esc(l.name)}</span>`).join('')}</p>
        </div>
      </section>
      <nav class="subtabs" aria-label="Home sections">
        ${HOME_TABS.map((s) => `<a href="#/home/${s}" class="${s === sub ? 'active' : ''}" ${s === sub ? 'aria-current="page"' : ''}>${s[0].toUpperCase() + s.slice(1)}</a>`).join('')}
      </nav>
      <div id="league-body">${loading()}</div>`;
    const body = () => document.getElementById('league-body');
    try {
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
      document.getElementById('home-eyebrow').textContent = `${SEASON} · Week ${week}`;

      // Click Overall / PF / PA to sort; click the active one again to flip direction.
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

  // Team's result for the selected week: final score vs opponent, live total, or projection.
  function weekScore(league, team, week, results, livePts, projPts) {
    const game = (results.get(team.id) || []).find((r) => r.week === week);
    if (!game || !game.opp) {
      const past = week < league.currentWeek, live = week === league.currentWeek;
      const pts = past ? (game ? f2(game.pf) : '—') : live ? f2(livePts) : f1(projPts);
      return `
        <div class="week-score bye">
          <span class="wl bye">B</span>
          <div class="ws-main">
            <span class="ws-label">Week ${week} · Bye · ${past ? 'Final' : live ? 'Live' : 'Projected'}</span>
            <span class="ws-pts">${pts}${live ? `<small>Proj ${f1(projPts)}</small>` : ''}</span>
          </div>
          <span class="ws-opp">No opponent this week</span>
        </div>`;
    }
    const opp = `<a class="ws-opp" href="#/${league.slug}/rosters?team=${game.opp.id}&week=${week}">vs ${teamLogo(game.opp, league, 'avatar xs')}<span>${esc(game.opp.name)}</span></a>`;
    if (game.result) {
      const word = { W: 'Win', L: 'Loss', T: 'Tie' }[game.result];
      return `
        <div class="week-score ${game.result}">
          <span class="wl ${game.result}">${game.result}</span>
          <div class="ws-main"><span class="ws-label">Week ${week} · Final · ${word}</span><span class="ws-pts">${f2(game.pf)}<small>–${f2(game.pa)}</small></span></div>
          ${opp}
        </div>`;
    }
    const live = week === league.currentWeek;
    return `
      <div class="week-score ${live ? 'live' : 'proj'}">
        <div class="ws-main">
          <span class="ws-label">Week ${week} · ${live ? 'Live' : 'Projected'}</span>
          <span class="ws-pts">${live ? f2(livePts) : f1(projPts)}${live ? `<small>Proj ${f1(projPts)}</small>` : ''}</span>
        </div>
        ${opp}
      </div>`;
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
          <a class="vs" href="#/cross-league?week=${x.week}" title="${esc(x.opp.team.name)} (${esc(lname)})">
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
            <a class="vs" href="#/${league.slug}/matchups?week=${r.week}">
              ${r.opp ? `<span class="muted">vs</span>${teamLogo(r.opp, league, 'avatar xs')}<span class="vs-name">${esc(r.opp.name)}</span>` : '<span class="muted">Bye week</span>'}
            </a>
          </li>
          ${crossList.filter((x) => x.week === r.week).map(crossRow).join('')}
        </ul>`;
    }).join('');

    const head = `<thead><tr><th class="c-slot"></th><th>Player</th><th class="c-score">Wk ${week}</th>
      <th class="c-num hide-sm">Rank</th><th class="c-num hide-sm">GP</th><th class="c-num hide-xs">FPTS</th><th class="c-num">PPG</th></tr></thead>`;

    body().innerHTML = `
      <div class="picker" role="list">${picker}</div>
      <section class="team-head">
        ${teamLogo(team, league, 'avatar xl')}
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
      ${note ? `<p class="fineprint week-note">${esc(note)}</p>` : ''}
      <div class="panel">
        <div class="panel-head">
          <h3>Starters</h3>
          ${weekScore(league, team, week, results, startersPts, startersProj)}
        </div>
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
          <span class="proj">Proj <b>${f1(side.proj)}</b></span>
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

  function matchupCard(g, league, featured, openIds) {
    if (g.bye) {
      const s = g.home;
      const score = g.byeState === 'upcoming' ? '' : `
        <div class="side-score bye-score">
          <span class="score">${f2(s.score)}</span>
          <span class="proj">${g.byeState === 'final' ? 'Final' : `Proj <b>${f1(s.proj)}</b>`}</span>
        </div>`;
      return `
        <article class="matchup bye-card" data-id="${g.id}">
          <div class="bye-row">
            ${teamLogo(s.team, league, 'avatar lg')}
            <div class="bye-id">
              <a class="side-name" href="#/${league.slug}/rosters?team=${s.team.id}">${esc(s.team.name)}</a>
              <span class="side-owner">${esc(s.team.owner)} · ${record(s.team)}</span>
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
      <article class="matchup ${featured ? 'featured' : ''}" data-id="${g.id}">
        ${featured ? `<div class="flag">Matchup of the week</div>` : ''}
        <div class="matchup-head">
          ${sideHead(g.home, league, 'left', homeLead)}
          <span class="vs-mark">vs</span>
          ${sideHead(g.away, league, 'right', awayLead)}
        </div>
        <div class="prob" role="img" aria-label="Win probability: ${esc(g.home.team.name)} ${pHome}%, ${esc(g.away.team.name)} ${100 - pHome}%">
          <span class="pct ${homeLead ? 'lead' : ''}">${pHome}%</span>
          <div class="bar"><i style="width:${pHome}%"></i></div>
          <span class="pct ${awayLead ? 'lead' : ''}">${100 - pHome}%</span>
        </div>
        <p class="prob-label">${g.decided ? 'Final' : 'Win probability'}</p>
        ${featured ? `<div class="banner"><span>${esc(featured)}</span></div>` : ''}
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

  function bindToggles(root) {
    root.querySelectorAll('.toggle').forEach((btn) => btn.addEventListener('click', () => {
      const panel = btn.closest('.matchup').querySelector('.lineups');
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open);
      btn.querySelector('span').textContent = open ? 'Hide lineups' : 'Show lineups';
      panel.hidden = !open;
    }));
  }

  function pickFeatured(data) {
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
    const week = clampWeek(league, params.get('week'));
    const data = await ESPN.getMatchups(league, week);
    if (token !== renderToken) return;

    const openIds = keepOpen || new Set();
    const featured = pickFeatured(data);
    const ordered = data.games.slice().sort((a, b) =>
      (featured && b.id === featured.id) - (featured && a.id === featured.id) || a.bye - b.bye);

    const cards = ordered.map((g, i) => {
      const card = matchupCard(g, league, featured && g.id === featured.id ? featured.label : null, openIds);
      return i === 1 && featured ? `<h2 class="section-label">The rest of the slate</h2>${card}` : card;
    }).join('');

    body().innerHTML = `
      <div class="matchups-bar">
        <p class="muted">${data.upcoming ? 'Upcoming matchups — lineups appear once the week begins.' : data.isCurrent ? 'Live scores and projections. Refreshes every minute.' : 'Final scores.'}</p>
        <label class="select">
          <span class="sr-only">Choose week</span>
          <select id="week-select">${weekOptions(league, week)}</select>
        </label>
      </div>
      <div class="matchup-list">${cards || '<div class="state">No matchups scheduled this week.</div>'}</div>`;

    body().querySelector('#week-select').addEventListener('change', (e) => {
      location.hash = `#/${league.slug}/matchups?week=${e.target.value}`;
    });
    bindToggles(body());

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
    return `<span class="lchip" style="--c:var(--${league.theme})">${esc(league.displayName || league.name)}</span>`;
  }

  function crossCard(g, records, ranks, openIds) {
    const pHome = Math.round(g.prob * 100);
    const homeLead = g.decided ? g.winner === 'home' : g.prob > 0.5;
    const awayLead = g.decided ? g.winner === 'away' : g.prob < 0.5;
    const side = (s, align, lead) => {
      if (s.missing) {
        return `<div class="side ${align}"><div class="side-id"><span class="side-name">${esc(s.team.name)}</span><span class="side-owner">Not found in ESPN</span></div></div>`;
      }
      const r = crossRecordText(s.team, records.get(`${s.league.slug}:${s.team.id}`));
      return sideHead(s, s.league, align, lead, {
        badge: `<span class="xl-badges"><span class="seed" title="Overall rank">#${ranks.get(`${s.league.slug}:${s.team.id}`)}</span>${leagueChip(s.league)}</span>`,
        rec: r.text, recTitle: r.title, style: `--accent:var(--${s.league.theme})`,
      });
    };
    const hasLineups = (g.home.lineup || g.away.lineup) && !g.home.missing && !g.away.missing;
    return `
      <article class="matchup cross" data-id="${g.id}" style="--home-c:var(--${g.home.league.theme});--away-c:var(--${g.away.league.theme})">
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
        ${hasLineups ? lineupToggle(g, openIds, lineupColumn(g.home, g.home.league) + lineupColumn(g.away, g.away.league)) : ''}
      </article>`;
  }

  function crossShell() {
    return `
      <section class="league-hero cross-hero">
        <img class="league-hero-logo seal" src="assets/img/mgdx-logo.png" alt="Microgen Fantasy Football logo" width="96" height="96">
        <div class="league-hero-text">
          <p class="eyebrow">Microgen Fantasy Football · ${SEASON}</p>
          <h1 class="page-title">Cross-League</h1>
          <p class="hero-dots">${LEAGUES.map((l) => `<span><i class="dot" style="--c:var(--${l.theme})"></i>${esc(l.name)}</span>`).join('')}</p>
        </div>
      </section>
      <div id="league-body">${loading()}</div>`;
  }

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
      let week = Number(params.get('week')) || currentWeek;
      if (!weeks.includes(week)) week = weeks.reduce((a, b) => (Math.abs(b - week) < Math.abs(a - week) ? b : a));

      const [sheet, weekData, records] = await Promise.all([
        SHEET.getWeek(week),
        Promise.all(leagues.map((l) => ESPN.getMatchups(l, week))),
        lockedStandings().then(async (file) => {
          if (file) return lockedCrossData(file);
          const o = await overallRecords();
          return { out: o.out, ranks: new Map(rankAllTeams(o).map((e) => [`${e.league.slug}:${e.team.id}`, e.rank])) };
        }),
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
          const toSide = (x) => (x.missing ? Object.assign({ score: 0, proj: 0, lineup: null }, x)
            : sides.get(`${x.league.slug}:${x.team.id}`) || Object.assign({ score: 0, proj: 0, lineup: null, week }, x));
          const home = toSide(a), away = toSide(b);
          const winner = !decided ? null : home.score > away.score ? 'home' : away.score > home.score ? 'away' : 'tie';
          return {
            id: `x${si}-${gi}`, home, away, decided, winner, upcoming,
            prob: ESPN.winProb(home, away, decided, winner),
          };
        }),
      }));

      const openIds = keepOpen || new Set();
      const options = weeks.map((w) => `<option value="${w}" ${w === week ? 'selected' : ''}>Week ${w}${w === currentWeek ? ' · current' : ''}</option>`).join('');
      const html = sections.map((sec) => {
        const head = sec.bye
          ? `<h2 class="xl-head"><span>Bye-week matchups</span></h2>`
          : `<h2 class="xl-head">${sec.leagues.map((l, i) => l
            ? `<span><i class="dot" style="--c:var(--${l.theme})"></i>${esc(l.displayName)}</span>`
            : `<span>${esc(sec.names[i])}</span>`).join('<em>vs.</em>')}</h2>`;
        return `<section class="xl-section">${head}${sec.games.map((g) => crossCard(g, crossOut, ranks, openIds)).join('')}</section>`;
      }).join('');

      body().innerHTML = `
        <div class="matchups-bar">
          <p class="muted">${upcoming ? 'Upcoming cross-league matchups.' : decided ? 'Final scores.' : 'Live scores and projections. Refreshes every minute.'} Records include in-league and cross-league games.</p>
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
      const sub = SUBTABS.includes(parts[1]) ? parts[1] : 'standings';
      setActiveNav(cfg.slug);
      renderLeague(cfg, sub, params);
    } else if (key === 'cross-league') {
      setActiveNav('cross-league');
      renderCrossLeague(params);
    } else if (PLACEHOLDERS[key]) {
      renderToken++;
      setActiveNav(key);
      renderPlaceholder(key);
    } else {
      setActiveNav('home');
      renderHome(HOME_TABS.includes(parts[1]) ? parts[1] : 'standings');
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
  route();
})();
