#!/usr/bin/env node
// Saves every finished regular-season game (in-league and cross-league) to games.json, for the all-time
// lists on Archives > Records. Run for the current season by the weekly workflow; tools/build-season.js
// runs it for a past season (MGDX_CONFIG=js/seasons/<year>.js), writing to that season's folder.
// Safe to run as often as you like: it only rewrites the file when something changed.
//
//   node tools/run-games.js
//
// games.json: { season, teams: { key: [team name, owner] },
//   games: [[week, keyA, scoreA, keyB, scoreB, link]] }   keyB is "median" for a game against the week's median.
const fs = require('fs');
const path = require('path');
require('./fetch-retry');
const { loadSite } = require('./load-site');

const { MGDX, SEASON_DATA, THIS_WEEK, dataDir } = loadSite(['js/espn.js', 'js/sheet.js', 'js/season.js', 'js/this-week.js']);
const OUTPUT = path.join(dataDir, 'games.json');
const LAST_REGULAR_WEEK = MGDX.ARCHIVE ? MGDX.ARCHIVE.lastWeek : 14;
const two = (n) => Math.round(n * 100) / 100;

async function main() {
  const leagues = await SEASON_DATA.loadAllLeagues();
  const currentWeek = Math.max(...leagues.map((l) => l.currentWeek));
  const teams = {};
  for (const l of leagues) for (const t of l.teams) teams[`${l.slug}:${t.id}`] = [t.name, t.owner];

  // 2023's bye teams played the week's median instead; those games are only in the season's standings file.
  let medians = [];
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'standings.json'), 'utf8'));
    if (st.season === MGDX.SEASON) {
      for (const [slug, l] of Object.entries(st.leagues)) {
        for (const t of l.teams) {
          for (const g of t.crossGames) {
            if (g.opp && g.opp.id == null && g.week <= LAST_REGULAR_WEEK) medians.push([g.week, `${slug}:${t.id}`, two(g.pf), 'median', two(g.pa), `#/cross-league?week=${g.week}`]);
          }
        }
      }
    }
  } catch { medians = []; }

  const games = [];
  for (let week = 1; week < currentWeek && week <= LAST_REGULAR_WEEK; week++) {
    const data = await THIS_WEEK.thisWeekGames(leagues, week);
    if (!data.crossOk) throw new Error(`Couldn't read the cross-league games for week ${week}.`);
    if (!data.final) {
      console.log(`Week ${week} isn't final on ESPN yet. Leaving it out.`);
      break;
    }
    const key = (s) => `${s.league.slug}:${s.team.id}`;
    for (const g of data.games) games.push([week, key(g.a), two(g.a.score), key(g.b), two(g.b.score), g.link]);
    games.push(...medians.filter((m) => m[0] === week));
  }

  const json = `${JSON.stringify({ season: MGDX.SEASON, teams, games })}\n`;
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (json === existing) {
    console.log('Games haven\'t changed. Nothing to do.');
    return;
  }
  fs.writeFileSync(OUTPUT, json);
  console.log(`Saved ${games.length} games through week ${games.length ? games[games.length - 1][0] : 0} (${Math.round(json.length / 1024)} KB).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
