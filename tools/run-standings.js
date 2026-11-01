#!/usr/bin/env node
// Saves everything the Standings tabs and Home standings show to data/standings.json, so they don't
// have to pull it live. Standings only count completed weeks, so this changes when ESPN moves to a
// new week, or if a stat correction changes a past score. Safe to run as often as you like: it only
// rewrites the file when something actually changed, and leaves it alone until last week is final.
//
//   node tools/run-standings.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'standings.json');

// The site's data files expect a browser `window`; here it is just the global object.
globalThis.window = globalThis;
for (const file of ['js/config.js', 'js/espn.js', 'js/sheet.js', 'js/season.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}
const { ESPN, SEASON_DATA, MGDX } = globalThis;

async function main() {
  const o = await SEASON_DATA.overallRecords();
  const week = o.currentWeek;
  const [results, cross] = await Promise.all([
    Promise.all(o.leagues.map((l) => ESPN.getResults(l))),
    SEASON_DATA.crossSchedules(),
  ]);

  // A new week can appear before last week's winners are set. Until then the site uses live data.
  const unfinished = o.leagues.flatMap((l, i) => l.teams.filter((t) =>
    (results[i].get(t.id) || []).some((r) => r.week === week - 1 && r.opp && !r.result)));
  if (unfinished.length) {
    console.log(`Week ${week - 1} isn't final on ESPN yet (${unfinished.length} teams). Will try again next run.`);
    return;
  }

  const leagues = {};
  o.leagues.forEach((l, i) => {
    const copy = { ...l, teams: l.teams.map((t) => ({ ...t })) };
    SEASON_DATA.applyOverall(copy, o.out);
    leagues[l.slug] = {
      playoffTeams: l.playoffTeams,
      teams: copy.teams.map((t) => ({
        id: t.id,
        name: t.name,
        owner: t.owner,
        logo: t.logo,
        titles: t.titles,
        grandTitles: t.grandTitles,
        wins: t.wins,
        losses: t.losses,
        ties: t.ties,
        inW: t.inW,
        inL: t.inL,
        inT: t.inT,
        xW: t.xW,
        xL: t.xL,
        xT: t.xT,
        pct: t.pct,
        pf: t.pf,
        byePf: t.byePf,
        pa: t.pa,
        crossPa: t.crossPa,
        crossGames: t.crossGames.map((g) => ({
          week: g.week,
          result: g.result,
          pf: g.pf,
          pa: g.pa,
          cross: true,
          opp: { id: g.opp.id, name: g.opp.name },
          oppLeague: { slug: g.oppLeague.slug, displayName: g.oppLeague.displayName },
        })),
        // The whole season's cross-league opponents for the Rosters schedule: [week, 'league:teamId'].
        crossSchedule: (cross.byTeam.get(`${l.slug}:${t.id}`) || [])
          .filter((x) => !x.opp.missing)
          .map((x) => [x.week, `${x.opp.league.slug}:${x.opp.team.id}`]),
      })),
      results: Object.fromEntries([...results[i]].map(([id, list]) => [id,
        list.filter((r) => r.week < week).map((r) => ({
          week: r.week,
          result: r.result,
          pf: r.pf,
          pa: r.pa,
          bye: r.bye,
          opp: r.opp ? { name: r.opp.name } : null,
        }))])),
    };
  });

  const json = `${JSON.stringify({ season: MGDX.SEASON, week, leagues })}\n`;
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (json === existing) {
    console.log(`Week ${week} standings haven't changed. Nothing to do.`);
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, json);
  console.log(`Saved standings through week ${week - 1} (${Math.round(json.length / 1024)} KB).`);
}

main().catch((err) => {
  // Leave the last good file in place; the site falls back to live data if it goes out of date.
  console.error(err);
  process.exit(1);
});
