#!/usr/bin/env node
// Saves the This Week cards for every finished week to data/this-week.json, so past weeks open without
// pulling rosters from ESPN, plus each team's season lineup totals for the report card grades on Luck Index.
// Safe to run as often as you like: it only rewrites the file when something changed, such as a stat
// correction. A week that isn't final on ESPN yet is left out, and the tab pulls it live.
//
//   node tools/run-this-week.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'this-week.json');

// The site's data files expect a browser `window`; here it is just the global object.
globalThis.window = globalThis;
for (const file of ['js/config.js', 'js/espn.js', 'js/sheet.js', 'js/season.js', 'js/this-week.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}
const { MGDX, SEASON_DATA, THIS_WEEK } = globalThis;

const two = (n) => Math.round(n * 100) / 100;
const ref = (side) => [`${side.league.slug}:${side.team.id}`, two(side.score)];
const game = (g) => (g ? { high: ref(g.high), low: ref(g.low), link: g.link, margin: two(g.margin), gap: two(g.gap) } : null);

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

async function main() {
  const leagues = await SEASON_DATA.loadAllLeagues();
  const currentWeek = Math.max(...leagues.map((l) => l.currentWeek));
  const teams = {};
  for (const l of leagues) {
    for (const t of l.teams) teams[`${l.slug}:${t.id}`] = { name: t.name, owner: t.owner, logo: t.logo };
  }

  const weeks = {};
  const lineups = {};
  for (let week = 1; week < currentWeek; week++) {
    const data = await THIS_WEEK.thisWeekGames(leagues, week);
    if (!data.crossOk) throw new Error(`Couldn't read the cross-league games for week ${week}.`);
    if (!data.final) {
      console.log(`Week ${week} isn't final on ESPN yet. Leaving it out.`);
      continue;
    }
    for (const side of data.sides) {
      const key = `${side.league.slug}:${side.team.id}`;
      const totals = (lineups[key] = lineups[key] || [0, 0]);
      totals[0] += side.lineup.starters.reduce((sum, p) => sum + (p.id ? p.points : 0), 0);
      totals[1] += potentialPoints(side.lineup, side.league.slotCounts);
    }
    const a = THIS_WEEK.thisWeekAwards(data, false);
    weeks[week] = {
      scores: a.scores.map(ref),
      closest: game(a.closest),
      blowout: game(a.blowout),
      upset: game(a.upset),
      badBeat: game(a.badBeat),
      luckyWin: game(a.luckyWin),
    };
  }

  for (const totals of Object.values(lineups)) totals.forEach((v, i) => { totals[i] = two(v); });
  const json = `${JSON.stringify({ season: MGDX.SEASON, teams, weeks, lineups })}\n`;
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (json === existing) {
    console.log('This Week results haven\'t changed. Nothing to do.');
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, json);
  console.log(`Saved ${Object.keys(weeks).length} weeks (${Math.round(json.length / 1024)} KB).`);
}

main().catch((err) => {
  // Leave the last good file in place; the tab pulls anything missing live.
  console.error(err);
  process.exit(1);
});
