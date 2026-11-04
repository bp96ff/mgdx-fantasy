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

  // The most points a roster could have started: tries every player in every open slot they're eligible for,
  // so a player who fits several slots can't throw it off. Injured reserve can't start, and a slot may stay empty.
  function potentialPoints(lineup, slotCounts) {
    const slots = Object.entries(slotCounts)
      .filter(([slot, count]) => slot !== '20' && slot !== '21' && count > 0)
      .flatMap(([slot, count]) => Array(count).fill(Number(slot)));
    let best = new Float64Array(1 << slots.length).fill(-Infinity);
    best[0] = 0;
    for (const p of lineup.starters.concat(lineup.bench)) {
      if (!p.id || p.slotId === 21) continue;
      const next = best.slice();
      for (let used = 0; used < best.length; used++) {
        if (best[used] === -Infinity) continue;
        slots.forEach((slot, i) => {
          const bit = 1 << i;
          if (used & bit || !p.slots.includes(slot)) return;
          next[used | bit] = Math.max(next[used | bit], best[used] + p.points);
        });
      }
      best = next;
    }
    return Math.max(...best);
  }

  const startedPoints = (lineup) => lineup.starters.reduce((sum, p) => sum + (p.id ? p.points : 0), 0);
  const sideKey = (s) => `${s.league.slug}:${s.team.id}`;

  // Season so far, by team: { key: [wins, losses, ties, points for, streak] }. A positive streak is wins in a
  // row, a negative one losses. Each week's in-league game counts before its cross-league game.
  function nextStanding(prev, sides, games, val) {
    const next = {};
    for (const s of sides) {
      const [w, l, t, pf, streak] = prev[sideKey(s)] || [0, 0, 0, 0, 0];
      next[sideKey(s)] = [w, l, t, Math.round((pf + val(s)) * 100) / 100, streak];
    }
    const record = (s, won, tied) => {
      const row = next[sideKey(s)];
      row[tied ? 2 : won ? 0 : 1]++;
      row[4] = tied ? 0 : won ? Math.max(row[4], 0) + 1 : Math.min(row[4], 0) - 1;
    };
    for (const g of games) {
      if (!(val(g.a) > 0 && val(g.b) > 0)) continue;
      const tied = val(g.a) === val(g.b);
      record(g.a, val(g.a) > val(g.b), tied);
      record(g.b, val(g.b) > val(g.a), tied);
    }
    return next;
  }

  // Overall rank across all four leagues: win percentage, then points for.
  function standingRanks(standing) {
    const pct = ([w, l, t]) => (w + l + t ? (w + t / 2) / (w + l + t) : 0);
    const order = Object.keys(standing).sort((a, b) => pct(standing[b]) - pct(standing[a]) || standing[b][3] - standing[a][3]);
    return new Map(order.map((key, i) => [key, i + 1]));
  }

  // Each week's two biggest climbs and falls in the overall ranks, and the two longest winning and losing streaks.
  function seasonCards(prev, standing, sides) {
    const byKey = new Map(sides.map((s) => [sideKey(s), s]));
    const ranks = standingRanks(standing);
    const keys = [...ranks.keys()].filter((key) => byKey.has(key));
    let movers = null;
    if (Object.keys(prev).length) {
      const before = standingRanks(prev);
      const moves = keys.filter((key) => before.has(key))
        .map((key) => ({ side: byKey.get(key), from: before.get(key), to: ranks.get(key) }));
      const change = (m) => m.from - m.to;
      movers = {
        up: moves.filter((m) => change(m) > 0).sort((a, b) => change(b) - change(a) || a.to - b.to).slice(0, 2),
        down: moves.filter((m) => change(m) < 0).sort((a, b) => change(a) - change(b) || a.to - b.to).slice(0, 2),
      };
    }
    const streakOf = (key) => standing[key][4];
    const longest = (list, length) => list.sort((a, b) => length(b) - length(a) || ranks.get(a) - ranks.get(b)).slice(0, 2)
      .map((key) => ({ side: byKey.get(key), length: length(key) }));
    return {
      movers,
      streaks: {
        hot: longest(keys.filter((key) => streakOf(key) > 0), streakOf),
        cold: longest(keys.filter((key) => streakOf(key) < 0), (key) => -streakOf(key)),
      },
    };
  }

  // While games are in progress everything is judged on ESPN's projected final scores; after that, on actual scores.
  // prev is the standing before this week ({} for Week 1). Without it, the movers and streaks cards are left out.
  function thisWeekAwards({ sides, games }, live, prev) {
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
    // Teams that won or lost every game they played this week.
    const sweeps = [];
    for (const s of sides) {
      const mine = decided.filter((g) => g.high === s || g.low === s);
      const won = mine.filter((g) => g.high === s).length;
      if (mine.length < 2 || (won > 0 && won < mine.length)) continue;
      sweeps.push({ side: s, won: won > 0, games: mine.map((g) => ({ opp: g.high === s ? g.low : g.high, link: g.link })) });
    }
    const managers = live ? null : sides.filter((s) => s.lineup && val(s) > 0)
      .map((s) => ({ side: s, actual: startedPoints(s.lineup), potential: potentialPoints(s.lineup, s.league.slotCounts) }))
      .filter((m) => m.potential > 0)
      .sort((a, b) => b.actual / b.potential - a.actual / a.potential || b.actual - a.actual)
      .slice(0, 3);
    const standing = prev ? nextStanding(prev, sides, games, val) : null;
    return {
      standing,
      ...(standing ? seasonCards(prev, standing, sides) : { movers: null, streaks: null }),
      managers,
      lowest: scored.slice(-3).reverse(),
      lostBoth: pick(sweeps.filter((x) => !x.won), (x) => val(x.side)),
      wonBoth: pick(sweeps.filter((x) => x.won), (x) => -val(x.side)),
      scores: scored.slice(0, 3),
      closest: pick(played, (g) => -g.margin),
      blowout: pick(played, (g) => g.margin),
      upset: upset && upset.gap > 0 ? upset : null,
      badBeat: pick(decided, (g) => val(g.low)),
      luckyWin: pick(decided, (g) => -val(g.high)),
    };
  }

  window.THIS_WEEK = { thisWeekGames, thisWeekAwards, stillPlaying, potentialPoints, startedPoints };
})();
