#!/usr/bin/env node
// Saves the This Week cards for every finished week to data/this-week.json, so past weeks open without
// pulling rosters from ESPN. Safe to run as often as you like: it only rewrites the file when something
// changed, such as a stat correction. A week that isn't final on ESPN yet is left out, and the tab pulls it live.
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

async function main() {
  const leagues = await SEASON_DATA.loadAllLeagues();
  const currentWeek = Math.max(...leagues.map((l) => l.currentWeek));
  const teams = {};
  for (const l of leagues) {
    for (const t of l.teams) teams[`${l.slug}:${t.id}`] = { name: t.name, owner: t.owner, logo: t.logo };
  }

  const weeks = {};
  for (let week = 1; week < currentWeek; week++) {
    const data = await THIS_WEEK.thisWeekGames(leagues, week);
    if (!data.crossOk) throw new Error(`Couldn't read the cross-league games for week ${week}.`);
    if (!data.final) {
      console.log(`Week ${week} isn't final on ESPN yet. Leaving it out.`);
      continue;
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

  const json = `${JSON.stringify({ season: MGDX.SEASON, teams, weeks })}\n`;
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
