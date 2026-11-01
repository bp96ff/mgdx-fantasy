// Season simulator behind the Power Rankings. Plain data in, odds out: no fetching or page code here.
//
// Each team gets an expected score per week: ESPN's rest-of-season player projections (best legal
// lineup, skipping NFL byes and expected missed games) blended with the team's actual scoring so far.
// The rest of the season is then played out many times with random weekly scores, using the real
// in-league and cross-league schedules, the standings rules and the playoff format.
(function () {
  const SIMS = 10000;
  const LAST_REGULAR_WEEK = 14;
  const ROUND_1_WEEK = 15; // seeds 3, 4, 5: highest score advances
  const ROUND_2_WEEK = 16; // seeds 1, 2 and the round 1 winner: highest score wins the league
  const LAST_NFL_WEEK = 18; // ESPN's rest-of-season totals run through here
  const ROSTER_WEIGHT = 0.65; // share of a team's expected score from projections; the rest is actual scoring
  const SKILL_SD = 6; // how far a team's true level could be from our estimate, points per week
  const MIN_SCORE = 40;

  // Expected points from the best legal lineup. Flex slots fill last, from who is left.
  function bestLineup(players, slotCounts, week, period) {
    const left = players.map((p) => {
      const onBye = p.bye === week;
      if (onBye || !p.rosAvg) return { p, pts: 0 };
      // rosGames is how many games ESPN expects; fewer than the weeks left means expected absences.
      const weeksLeft = LAST_NFL_WEEK - period + 1 - (p.bye >= period ? 1 : 0);
      return { p, pts: p.rosAvg * Math.min(1, p.rosGames / Math.max(1, weeksLeft)) };
    }).sort((a, b) => b.pts - a.pts);
    const slots = Object.keys(slotCounts).map(Number).filter((s) => s !== 20 && s !== 21 && slotCounts[s] > 0)
      .sort((a, b) => (a === 23 || a === 7) - (b === 23 || b === 7));
    let total = 0;
    for (const slot of slots) {
      for (let n = 0; n < slotCounts[slot]; n++) {
        const i = left.findIndex((c) => c.p.slots.includes(slot));
        if (i >= 0) total += left.splice(i, 1)[0].pts;
      }
    }
    return total;
  }

  function mulberry32(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // teams: [{ key, league, wins, losses, ties, pf, players, slotCounts, scores: { week: points } }]
  // games: { week: [[keyA, keyB], ...] } for regular-season weeks not yet final, each game listed once.
  // current: { week, period, live: { key: { score, proj } } }
  function simulate({ teams, games, current, sims = SIMS, seed }) {
    const n = teams.length;
    const index = new Map(teams.map((t, i) => [t.key, i]));
    const firstWeek = current.week;
    const weeks = [];
    for (let w = firstWeek; w <= ROUND_2_WEEK; w++) weeks.push(w);

    // Weekly spread: how much teams swing around their own average, across all completed weeks.
    let sumSq = 0;
    let df = 0;
    const ppg = teams.map((t) => {
      const vals = Object.entries(t.scores).filter(([w]) => Number(w) < firstWeek).map(([, v]) => v);
      if (!vals.length) return null;
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      vals.forEach((v) => { sumSq += (v - avg) ** 2; });
      df += vals.length - 1;
      return avg;
    });
    const weeklySD = df > 0 ? Math.sqrt(sumSq / df) : 28;

    // means[weekIndex][team]
    const means = weeks.map((w) => teams.map((t, i) => {
      const roster = bestLineup(t.players, t.slotCounts, w, current.period);
      return ppg[i] == null ? roster : ROSTER_WEIGHT * roster + (1 - ROSTER_WEIGHT) * ppg[i];
    }));
    const gameIdx = weeks.map((w) => (games[w] || []).map(([a, b]) => [index.get(a), index.get(b)])
      .filter(([a, b]) => a != null && b != null));

    const byLeague = new Map();
    teams.forEach((t, i) => {
      if (!byLeague.has(t.league)) byLeague.set(t.league, []);
      byLeague.get(t.league).push(i);
    });

    const counts = teams.map(() => ({ playoffs: 0, bye: 0, title: 0 }));
    const random = mulberry32(seed);
    const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

    const wins = new Float64Array(n);
    const played = new Float64Array(n);
    const pf = new Float64Array(n);
    const skill = new Float64Array(n);
    const scores = weeks.map(() => new Float64Array(n));

    for (let s = 0; s < sims; s++) {
      for (let t = 0; t < n; t++) {
        const T = teams[t];
        wins[t] = T.wins + T.ties / 2;
        played[t] = T.wins + T.losses + T.ties;
        pf[t] = T.pf;
        skill[t] = SKILL_SD * normal();
      }
      for (let wi = 0; wi < weeks.length; wi++) {
        const w = weeks[wi];
        const row = scores[wi];
        for (let t = 0; t < n; t++) {
          const live = w === firstWeek ? current.live[teams[t].key] : null;
          if (live) {
            // In progress: only the unplayed part of the projection is still uncertain.
            const share = Math.sqrt(Math.max(0, live.proj - live.score) / Math.max(1, live.proj));
            row[t] = Math.max(live.score, live.proj + share * (weeklySD * normal() + skill[t]));
          } else {
            row[t] = Math.max(MIN_SCORE, means[wi][t] + skill[t] + weeklySD * normal());
          }
          if (w <= LAST_REGULAR_WEEK) pf[t] += row[t];
        }
        const list = gameIdx[wi];
        for (let g = 0; g < list.length; g++) {
          const a = list[g][0];
          const b = list[g][1];
          played[a]++;
          played[b]++;
          if (row[a] > row[b]) wins[a]++;
          else if (row[b] > row[a]) wins[b]++;
          else { wins[a] += 0.5; wins[b] += 0.5; }
        }
      }
      for (const members of byLeague.values()) {
        const order = members.slice().sort((a, b) =>
          (wins[b] / (played[b] || 1)) - (wins[a] / (played[a] || 1)) || pf[b] - pf[a]);
        order.slice(0, 5).forEach((t) => { counts[t].playoffs++; });
        order.slice(0, 2).forEach((t) => { counts[t].bye++; });
        const scoreIn = (week, t) => {
          const final = teams[t].scores[week];
          if (week < firstWeek && final != null) return final;
          return week >= firstWeek ? scores[week - firstWeek][t] : 0;
        };
        const best = (week, field) => field.reduce((x, y) => (scoreIn(week, y) > scoreIn(week, x) ? y : x));
        const round1Winner = best(ROUND_1_WEEK, order.slice(2, 5));
        counts[best(ROUND_2_WEEK, [order[0], order[1], round1Winner])].title++;
      }
    }

    return {
      sims,
      weeklySD,
      odds: new Map(teams.map((t, i) => [t.key, {
        playoffs: counts[i].playoffs / sims,
        bye: counts[i].bye / sims,
        title: counts[i].title / sims,
        expected: means[Math.min(1, means.length - 1)][i],
      }])),
    };
  }

  window.PROJECTIONS = { simulate, bestLineup, SIMS, ROSTER_WEIGHT, LAST_REGULAR_WEEK };
})();
