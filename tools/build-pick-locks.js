#!/usr/bin/env node
// Writes supabase/pick-locks-<season>.sql: when each regular-season week's Predictions lock, which is when
// that week's first NFL game kicks off (from ESPN's NFL schedule). Run it once a season, after the schedule
// is out, then run the file in Supabase's SQL editor. Run it again if the NFL moves a week's first game.
//
//   node tools/build-pick-locks.js
const fs = require('fs');
const path = require('path');
require('./fetch-retry');
const { loadSite } = require('./load-site');

const { MGDX, ESPN, ROOT } = loadSite(['js/espn.js']);

async function main() {
  const league = await ESPN.getLeague(MGDX.LEAGUES[0]);
  const kickoffs = await ESPN.firstKickoffs();
  const rows = [];
  for (let week = 1; week <= league.regularSeasonWeeks; week++) {
    const period = (league.matchupPeriods[week] || [week])[0];
    if (!kickoffs[period]) throw new Error(`ESPN has no NFL games for week ${week} (scoring period ${period}).`);
    rows.push(`  (${MGDX.SEASON}, ${week}, '${new Date(kickoffs[period]).toISOString()}')`);
  }
  const file = path.join(ROOT, 'supabase', `pick-locks-${MGDX.SEASON}.sql`);
  fs.writeFileSync(file, `-- When each ${MGDX.SEASON} week's Predictions lock: its first NFL game's kickoff (UTC).
-- Made by node tools/build-pick-locks.js. Safe to run again; it updates the times.
insert into public.pick_locks (season, week, locks_at) values
${rows.join(',\n')}
on conflict (season, week) do update set locks_at = excluded.locks_at;
`);
  console.log(`Wrote ${path.relative(ROOT, file)} (${rows.length} weeks).`);
  for (const r of rows) console.log(r.trim());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
