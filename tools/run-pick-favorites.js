#!/usr/bin/env node
// Saves each team's max projected lineup for the current week to data/predictions.json, just before the week's
// Predictions lock (its first NFL game). Those totals decide each game's favorite (1 point) and underdog
// (2 points). Max projected = the best legal lineup from the whole roster (not injured reserve) by ESPN's
// projections for the week.
//
// The Predictions workflow runs this every 30 minutes Wednesday through Friday (UTC). It does nothing until
// the 2 hours before the lock, then saves on each run, so the last save before kickoff is the one that counts.
// If no run made it before kickoff, the first run after saves one and marks it late.
//
//   node tools/run-pick-favorites.js          (does nothing outside that window)
//   node tools/run-pick-favorites.js --now    (saves now, for testing; never after the lock)
const fs = require('fs');
const path = require('path');
require('./fetch-retry');
const { loadSite } = require('./load-site');

const { MGDX, ESPN, THIS_WEEK, dataDir } = loadSite(['js/espn.js', 'js/sheet.js', 'js/season.js', 'js/this-week.js']);
const OUTPUT = path.join(dataDir, 'predictions.json');
const WINDOW_MS = 2 * 3600e3; // start saving this long before the lock
const LATE_MS = 4 * 86400e3; // a missed week is saved late only within this long after the lock

const two = (n) => Math.round(n * 100) / 100;

async function main() {
  const force = process.argv.includes('--now');
  const leagues = await Promise.all(MGDX.LEAGUES.map((cfg) => ESPN.getLeague(cfg).then((l) => Object.assign(l, { slug: cfg.slug }))));
  const week = Math.max(...leagues.map((l) => l.currentWeek));
  if (week > leagues[0].regularSeasonWeeks) return console.log('The regular season is over. Nothing to save.');
  const kickoffs = await ESPN.firstKickoffs();
  const locksAt = kickoffs[(leagues[0].matchupPeriods[week] || [week])[0]];
  if (!locksAt) throw new Error(`ESPN has no NFL games for week ${week}.`);

  let file = { season: MGDX.SEASON, weeks: {} };
  try { file = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch (err) { /* first save */ }
  if (file.season !== MGDX.SEASON) file = { season: MGDX.SEASON, weeks: {} };
  const saved = file.weeks[week];
  const now = Date.now();
  const when = new Date(locksAt).toISOString();
  if (now >= locksAt) {
    if (saved) return console.log(`Week ${week} locked at ${when}; its favorites are already saved.`);
    if (now > locksAt + LATE_MS) return console.log(`Week ${week} locked at ${when}, too long ago to save it now.`);
  } else if (!force && now < locksAt - WINDOW_MS) {
    return console.log(`Week ${week} locks at ${when}. Nothing to save yet.`);
  }

  const proj = {};
  for (const l of leagues) {
    const rosters = await ESPN.getRosters(l, week);
    for (const t of l.teams) {
      const lineup = rosters.byTeam.get(t.id);
      if (!lineup) throw new Error(`ESPN has no roster for ${l.slug} team ${t.id}.`);
      proj[`${l.slug}.${t.id}`] = two(THIS_WEEK.potentialPoints(lineup, l.slotCounts, (p) => p.proj));
    }
  }
  const late = now >= locksAt;
  const same = saved && JSON.stringify(saved.proj) === JSON.stringify(proj);
  if (same) return console.log(`Week ${week}: the projections haven't changed since the last save.`);
  file.weeks[week] = { locksAt: when, savedAt: new Date(now).toISOString(), ...(late ? { late: true } : {}), proj };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(file, null, 1)}\n`);
  console.log(`Saved week ${week}'s max projections${late ? ' (late: after the lock)' : ''} for ${Object.keys(proj).length} teams.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
