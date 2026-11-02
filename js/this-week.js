// The card math behind Home's This Week tab, shared by the site and tools/run-this-week.js.
(function () {
  const { resolveWeek } = window.SEASON_DATA;

  const preGame = (side) => (side.lineup ? side.lineup.starters.reduce((sum, p) => sum + (p.proj || 0), 0) : null);
  const stillPlaying = (side) => !!side.lineup && side.lineup.starters.some((p) => p.id && (p.game.state === 'pre' || p.game.state === 'live'));

  // Every game this week, in-league and cross-league, with each team's score and lineup.
  async function thisWeekGames(leagues, week) {
    const weekData = await Promise.all(leagues.map((l) => ESPN.getMatchups(l, week)));
    const sides = new Map();
    const byeTeams = [];
    leagues.forEach((l, i) => {
      for (const g of weekData[i].games) {
        for (const s of [g.home, g.away]) if (s) sides.set(`${l.slug}:${s.team.id}`, Object.assign({}, s, { league: l }));
        if (g.bye) byeTeams.push({ league: l, team: g.home.team });
      }
    });
    const games = [];
    weekData.forEach((d, i) => {
      for (const g of d.games) {
        if (!g.bye) {
          games.push({
            a: sides.get(`${leagues[i].slug}:${g.home.team.id}`),
            b: sides.get(`${leagues[i].slug}:${g.away.team.id}`),
            link: `#/${leagues[i].slug}/matchups?week=${week}&game=${g.id}`,
          });
        }
      }
    });
    let crossOk = true;
    if (SHEET.weeks.includes(week)) {
      try {
        resolveWeek(await SHEET.getWeek(week), leagues, byeTeams).forEach((sec, si) => {
          sec.games.forEach(([x, y], gi) => {
            if (x.missing || y.missing) return;
            const a = sides.get(`${x.league.slug}:${x.team.id}`);
            const b = sides.get(`${y.league.slug}:${y.team.id}`);
            if (a && b) games.push({ a, b, link: `#/cross-league?week=${week}&game=x${si}-${gi}` });
          });
        });
      } catch (err) {
        console.warn('This Week: cross-league games unavailable', err);
        crossOk = false;
      }
    }
    const final = weekData.every((d) => d.games.every((g) => g.bye || g.decided));
    return { sides: [...sides.values()], games, crossOk, final };
  }

  // While games are in progress everything is judged on ESPN's projected final scores; after that, on actual scores.
  function thisWeekAwards({ sides, games }, live) {
    const val = (s) => (live ? s.proj : s.score);
    const played = games.filter((g) => val(g.a) > 0 && val(g.b) > 0).map((g) => {
      const [high, low] = val(g.a) >= val(g.b) ? [g.a, g.b] : [g.b, g.a];
      const pre = [preGame(high), preGame(low)];
      return { high, low, link: g.link, margin: val(high) - val(low), gap: pre[0] != null && pre[1] != null ? pre[1] - pre[0] : 0 };
    });
    const pick = (list, value) => list.reduce((best, x) => (!best || value(x) > value(best) ? x : best), null);
    const decided = played.filter((g) => g.margin > 0);
    const scored = sides.filter((s) => val(s) > 0).sort((a, b) => val(b) - val(a));
    const upset = pick(decided, (g) => g.gap);
    return {
      scores: scored.slice(0, 3),
      closest: pick(played, (g) => -g.margin),
      blowout: pick(played, (g) => g.margin),
      upset: upset && upset.gap > 0 ? upset : null,
      badBeat: pick(decided, (g) => val(g.low)),
      luckyWin: pick(decided, (g) => -val(g.high)),
    };
  }

  window.THIS_WEEK = { thisWeekGames, thisWeekAwards, stillPlaying };
})();
