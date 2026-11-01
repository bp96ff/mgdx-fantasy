#!/usr/bin/env node
// Runs the Power Rankings simulation once per NFL week and saves the results to
// data/power-rankings.json, which is all the website reads. Safe to run as often as you like:
// it does nothing until ESPN has moved to a new week and finalized the previous one.
//
//   node tools/run-power-rankings.js           run if a new week needs it
//   node tools/run-power-rankings.js --force   recalculate the current week anyway
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'power-rankings.json');

// The site's data files expect a browser `window`; here it is just the global object.
globalThis.window = globalThis;
for (const file of ['js/config.js', 'js/espn.js', 'js/sheet.js', 'js/season.js', 'tools/projections.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}
const { ESPN, PROJECTIONS, SEASON_DATA, MGDX } = globalThis;

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const force = process.argv.includes('--force');
  const o = await SEASON_DATA.overallRecords();
  const week = o.currentWeek;
  const existing = readExisting();

  if (!force && existing && existing.season === MGDX.SEASON && existing.week === week) {
    console.log(`Week ${week} is already locked (calculated ${existing.calculatedAt}). Nothing to do.`);
    return;
  }

  const [results, rosters, matchups, cross] = await Promise.all([
    Promise.all(o.leagues.map((l) => ESPN.getResults(l))),
    Promise.all(o.leagues.map((l) => ESPN.getRosters(l))),
    Promise.all(o.leagues.map((l) => ESPN.getMatchups(l, week))),
    SEASON_DATA.crossSchedules(),
  ]);

  // Wait for ESPN to finish last week: a new week can appear before last week's winners are set.
  const unfinished = o.leagues.flatMap((l, i) => l.teams.filter((t) =>
    (results[i].get(t.id) || []).some((r) => r.week === week - 1 && r.opp && !r.result)));
  if (!force && unfinished.length) {
    console.log(`Week ${week - 1} isn't final on ESPN yet (${unfinished.length} teams). Will try again next run.`);
    return;
  }

  const teams = [];
  const games = {};
  const live = {};
  const addGame = (w, a, b) => {
    if (w < week || w > PROJECTIONS.LAST_REGULAR_WEEK || a >= b) return; // each game is listed from both sides
    (games[w] = games[w] || []).push([a, b]);
  };
  o.leagues.forEach((l, i) => {
    for (const t of l.teams) {
      const key = `${l.slug}:${t.id}`;
      const c = o.out.get(key) || { w: 0, l: 0, t: 0 };
      const roster = rosters[i].byTeam.get(t.id) || { starters: [], bench: [] };
      const list = results[i].get(t.id) || [];
      teams.push({
        key,
        league: l.slug,
        wins: t.wins + c.w,
        losses: t.losses + c.l,
        ties: (t.ties || 0) + c.t,
        pf: t.pf,
        players: roster.starters.concat(roster.bench).filter((p) => p.id),
        slotCounts: l.slotCounts,
        scores: Object.fromEntries(list.filter((r) => r.result || r.bye).map((r) => [r.week, r.pf])),
      });
      for (const r of list) if (r.opp) addGame(r.week, key, `${l.slug}:${r.opp.id}`);
      for (const x of cross.byTeam.get(key) || []) {
        if (!x.opp.missing) addGame(x.week, key, `${x.opp.league.slug}:${x.opp.team.id}`);
      }
    }
    for (const g of matchups[i].games) {
      for (const s of [g.home, g.away]) {
        if (s) live[`${l.slug}:${s.team.id}`] = { score: s.score, proj: s.proj };
      }
    }
  });

  const period = Math.max(...o.leagues.map((l) => l.currentPeriod));
  const { odds, sims, weeklySD } = PROJECTIONS.simulate({ teams, games, current: { week, period, live }, seed: week * 7919 });
  const round = (v) => Math.round(v * 10000) / 10000;
  const output = {
    season: MGDX.SEASON,
    week,
    calculatedAt: new Date().toISOString(),
    sims,
    weeklySD: Math.round(weeklySD * 10) / 10,
    odds: Object.fromEntries(teams.map((t) => t.key).sort().map((key) => {
      const v = odds.get(key);
      return [key, { playoffs: round(v.playoffs), bye: round(v.bye), title: round(v.title) }];
    })),
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 1)}\n`);
  console.log(`Locked week ${week}: ${teams.length} teams, ${sims.toLocaleString('en-US')} simulations.`);
}

main().catch((err) => {
  // Leave the last good file in place; the next scheduled run tries again.
  console.error(err);
  process.exit(1);
});
