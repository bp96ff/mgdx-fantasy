// League and cross-league data shared by the site and the weekly Power Rankings script (no page code here).
(function () {
  const { LEAGUES } = window.MGDX;

  const UNKNOWN_LEAGUE = { slug: '', name: 'Unknown', logo: 'assets/img/mgdx-shield.png?v=3', teams: [], theme: 'home' };

  async function loadAllLeagues() {
    return Promise.all(LEAGUES.map(async (cfg) => Object.assign({}, await ESPN.getLeague(cfg),
      { slug: cfg.slug, logo: cfg.logo, art: cfg.art, displayName: cfg.name, theme: cfg.theme })));
  }

  // Sheet names are owner first names, sometimes shortened ("Jen" for Jennifer).
  function matchOwner(candidates, name) {
    const n = name.trim().toLowerCase();
    const exact = candidates.filter((c) => c.team.owner.toLowerCase() === n);
    if (exact.length === 1) return exact[0];
    const prefix = candidates.filter((c) => {
      const o = c.team.owner.toLowerCase();
      return o.startsWith(n) || n.startsWith(o);
    });
    return prefix.length === 1 ? prefix[0] : null;
  }

  function leagueByName(leagues, name) {
    const n = name.trim().toLowerCase();
    return leagues.find((l) => l.displayName.toLowerCase() === n || l.name.toLowerCase() === n) || null;
  }

  // Resolve every sheet pairing for one week to { league, team } on each side.
  // byeTeams: [{ league, team }] for that week, used for the "Bye Weeks" section.
  function resolveWeek(sections, leagues, byeTeams) {
    return sections.map((s) => {
      const lg = s.bye ? [null, null] : s.leagues.map((n) => leagueByName(leagues, n));
      const teamsOf = (ls) => ls.flatMap((l) => l.teams.map((team) => ({ league: l, team })));
      // An unrecognized header (typo) falls back to searching the leagues not already named.
      const pools = s.bye
        ? [byeTeams, byeTeams]
        : lg.map((l, i) => (l ? teamsOf([l]) : teamsOf(leagues.filter((x) => x !== lg[1 - i]))));
      const games = s.games.map(([a, b]) => [a, b].map((name, i) => {
        const hit = matchOwner(pools[i], name);
        if (!hit) console.warn(`Cross-league: couldn't match "${name}"`);
        return hit || { league: lg[i] || UNKNOWN_LEAGUE, team: { id: null, name, owner: name, logo: '' }, missing: true };
      }));
      if (!s.bye) {
        lg.forEach((l, i) => {
          if (l) return;
          const found = games.map((g) => g[i]).find((x) => !x.missing);
          if (found) lg[i] = found.league;
        });
      }
      return { bye: s.bye, leagues: lg, names: s.leagues, games };
    });
  }

  // Overall record per team: ESPN in-league record + cross-league results from completed weeks.
  async function crossRecords(leagues, currentWeek) {
    const results = await Promise.all(leagues.map((l) => ESPN.getResults(l)));
    const scores = new Map();   // `${slug}:${teamId}:${week}` -> points
    const byes = new Map();     // week -> [{ league, team }]
    leagues.forEach((l, i) => {
      for (const [teamId, list] of results[i]) {
        for (const r of list) {
          scores.set(`${l.slug}:${teamId}:${r.week}`, r.pf);
          if (r.bye) {
            if (!byes.has(r.week)) byes.set(r.week, []);
            byes.get(r.week).push({ league: l, team: l.teamById.get(teamId) });
          }
        }
      }
    });
    const out = new Map();
    const rec = (k) => out.get(k) || out.set(k, { w: 0, l: 0, t: 0, games: [] }).get(k);
    const log = (k, week, res, pf, pa, opp) => {
      const r = rec(k);
      r[res === 'W' ? 'w' : res === 'L' ? 'l' : 't']++;
      r.games.push({ week, result: res, pf, pa, opp: opp.team, oppLeague: opp.league, cross: true });
    };
    const pastWeeks = SHEET.weeks.filter((w) => w < currentWeek);
    const sheets = await Promise.all(pastWeeks.map((w) => SHEET.getWeek(w)));
    pastWeeks.forEach((w, i) => {
      for (const sec of resolveWeek(sheets[i], leagues, byes.get(w) || [])) {
        for (const [a, b] of sec.games) {
          if (a.missing || b.missing) continue;
          const ka = `${a.league.slug}:${a.team.id}`, kb = `${b.league.slug}:${b.team.id}`;
          const pa = scores.get(`${ka}:${w}`) || 0, pb = scores.get(`${kb}:${w}`) || 0;
          const ra = pa > pb ? 'W' : pb > pa ? 'L' : 'T';
          const rb = ra === 'W' ? 'L' : ra === 'L' ? 'W' : 'T';
          log(ka, w, ra, pa, pb, b);
          log(kb, w, rb, pb, pa, a);
        }
      }
    });
    return { out, byes };
  }

  // All four leagues + cross-league results, shared by every league page (cached briefly).
  let overallCache = null;
  function overallRecords() {
    if (overallCache && Date.now() - overallCache.t < 60000) return overallCache.p;
    const p = (async () => {
      const leagues = await loadAllLeagues();
      const currentWeek = Math.max(...leagues.map((l) => l.currentWeek));
      return Object.assign({ leagues, currentWeek }, await crossRecords(leagues, currentWeek));
    })();
    overallCache = { t: Date.now(), p };
    p.catch(() => { overallCache = null; });
    return p;
  }

  // Every team's cross-league games for the whole season, played or not, from all the sheet's week tabs.
  async function crossSchedules() {
    const o = await overallRecords();
    const sheets = await Promise.all(SHEET.weeks.map((w) => SHEET.getWeek(w)));
    const byTeam = new Map();
    SHEET.weeks.forEach((week, i) => {
      resolveWeek(sheets[i], o.leagues, o.byes.get(week) || []).forEach((sec, si) => {
        sec.games.forEach(([a, b], gi) => {
          for (const [me, opp] of [[a, b], [b, a]]) {
            if (me.missing) continue;
            const key = `${me.league.slug}:${me.team.id}`;
            if (!byTeam.has(key)) byTeam.set(key, []);
            byTeam.get(key).push({ week, opp, game: `x${si}-${gi}`, bye: !!sec.bye });
          }
        });
      });
    });
    return { byTeam, out: o.out };
  }

  // Turn a league's records into overall records (in-league + cross-league) and re-rank:
  // overall win %, then PF. Keeps the in-league split on each team as inW/inL/inT.
  function applyOverall(league, cross) {
    for (const t of league.teams) {
      const c = cross.get(`${league.slug}:${t.id}`) || { w: 0, l: 0, t: 0, games: [] };
      Object.assign(t, {
        inW: t.wins, inL: t.losses, inT: t.ties || 0,
        xW: c.w, xL: c.l, xT: c.t, crossGames: c.games,
      });
      t.wins = t.inW + c.w; t.losses = t.inL + c.l; t.ties = t.inT + c.t;
      // PA counts every opponent; PF already counts each week's score once (byes included).
      t.crossPa = c.games.reduce((s, g) => s + g.pa, 0);
      t.pa += t.crossPa;
      const gp = t.wins + t.losses + t.ties;
      t.pct = gp ? (t.wins + t.ties / 2) / gp : 0;
    }
    league.teams.sort((a, b) => b.pct - a.pct || b.pf - a.pf);
    league.overall = true;
  }

  window.SEASON_DATA = { loadAllLeagues, resolveWeek, overallRecords, crossSchedules, applyOverall };
})();
