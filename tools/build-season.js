#!/usr/bin/env node
// Saves a finished season for its own season page (for example 2023.html), so the page never asks ESPN again.
// Needs js/seasons/<year>.js, plus cross.json and playoffs.json from tools/build-history.py.
//
//   node tools/build-season.js 2023
//
// 1. Saves ESPN's league, weekly matchups, weekly rosters and the NFL schedule to data/seasons/<year>/espn/,
//    keeping only what the site reads. Playoff weeks keep each team's lineup but not ESPN's own playoff
//    games: the bracket comes from the league's sheet (playoffs.json).
// 2. Runs tools/run-standings.js and tools/run-this-week.js against those files.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const year = Number(process.argv[2]);
const configFile = `js/seasons/${year}.js`;
if (!year || !fs.existsSync(path.join(ROOT, configFile))) {
  console.error(`Usage: node tools/build-season.js <year>   (needs ${configFile})`);
  process.exit(1);
}
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, configFile), 'utf8'), { filename: configFile });
const { MGDX } = globalThis;
const { lastWeek, dir, playoffWeeks = [] } = MGDX.ARCHIVE;
const finalWeek = Math.max(lastWeek, ...playoffWeeks);
const OUT = path.join(ROOT, dir, 'espn');
const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}`;

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ESPN responded ${r.status} for ${url}`);
      return await r.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data)}\n`);
}

// Box-score stat ids the site's stat line uses (js/espn.js statLine).
const LINE_STATS = [0, 3, 4, 20, 23, 24, 25, 42, 43, 53, 58, 83, 85];
function slimEntry(e, week) {
  const pe = e.playerPoolEntry || {};
  const p = pe.player || {};
  const stats = (p.stats || [])
    .filter((s) => (s.seasonId == null || s.seasonId === year) && (s.statSplitTypeId === 0 || s.scoringPeriodId === week))
    .map((s) => {
      const out = {
        statSourceId: s.statSourceId, statSplitTypeId: s.statSplitTypeId, scoringPeriodId: s.scoringPeriodId,
        seasonId: s.seasonId, appliedTotal: s.appliedTotal, appliedAverage: s.appliedAverage,
      };
      if (s.statSourceId === 0 && s.statSplitTypeId === 1 && s.stats) {
        out.stats = Object.fromEntries(LINE_STATS.filter((id) => s.stats[id]).map((id) => [id, s.stats[id]]));
      }
      return out;
    });
  const rating = pe.ratings && pe.ratings['0'];
  return {
    lineupSlotId: e.lineupSlotId,
    injuryStatus: e.injuryStatus,
    playerPoolEntry: {
      ratings: rating ? { 0: { positionalRanking: rating.positionalRanking } } : undefined,
      player: {
        id: p.id, fullName: p.fullName, defaultPositionId: p.defaultPositionId, proTeamId: p.proTeamId,
        injuryStatus: p.injuryStatus, eligibleSlots: p.eligibleSlots, stats,
      },
    },
  };
}

function slimSide(side, week) {
  if (!side) return undefined;
  const entries = ((side.rosterForCurrentScoringPeriod || side.rosterForMatchupPeriod || {}).entries || []).map((e) => slimEntry(e, week));
  return { teamId: side.teamId, totalPoints: side.totalPoints, rosterForCurrentScoringPeriod: { entries } };
}

async function saveLeague(cfg) {
  const d = await get(`${BASE}/segments/0/leagues/${cfg.id}?view=mTeam&view=mSettings&view=mMatchupScore`);
  const sched = d.settings.scheduleSettings;
  const periods = Object.fromEntries(Object.entries(sched.matchupPeriods || {}).filter(([w]) => Number(w) <= lastWeek));
  save(`${cfg.id}.json`, {
    // The season is over: every regular-season week is in the past.
    status: { currentMatchupPeriod: lastWeek + 1, finalScoringPeriod: lastWeek },
    scoringPeriodId: lastWeek + 1,
    members: (d.members || []).map((m) => ({ id: m.id, firstName: m.firstName, displayName: m.displayName })),
    teams: d.teams.map((t) => ({
      id: t.id, name: t.name, location: t.location, nickname: t.nickname, abbrev: t.abbrev, logo: t.logo,
      owners: t.owners, primaryOwner: t.primaryOwner, record: t.record,
    })),
    settings: {
      name: d.settings.name,
      size: d.settings.size,
      rosterSettings: { lineupSlotCounts: d.settings.rosterSettings.lineupSlotCounts },
      scheduleSettings: { playoffTeamCount: sched.playoffTeamCount, matchupPeriodCount: lastWeek, matchupPeriods: periods },
    },
    schedule: d.schedule.filter((m) => m.matchupPeriodId <= lastWeek).map((m) => ({
      id: m.id, matchupPeriodId: m.matchupPeriodId, playoffTierType: m.playoffTierType, winner: m.winner,
      home: m.home && { teamId: m.home.teamId, totalPoints: m.home.totalPoints },
      away: m.away && { teamId: m.away.teamId, totalPoints: m.away.totalPoints },
    })),
  });
  for (let week = 1; week <= lastWeek; week++) {
    const m = await get(`${BASE}/segments/0/leagues/${cfg.id}?view=mMatchupScore&view=mScoreboard&scoringPeriodId=${week}`);
    save(`${cfg.id}-matchups-${week}.json`, {
      schedule: m.schedule.filter((g) => g.matchupPeriodId === week).map((g) => ({
        id: g.id, matchupPeriodId: g.matchupPeriodId, playoffTierType: g.playoffTierType, winner: g.winner,
        home: slimSide(g.home, week), away: slimSide(g.away, week),
      })),
    });
    const r = await get(`${BASE}/segments/0/leagues/${cfg.id}?view=mRoster&scoringPeriodId=${week}`);
    save(`${cfg.id}-rosters-${week}.json`, {
      teams: r.teams.map((t) => ({ id: t.id, roster: { entries: ((t.roster || {}).entries || []).map((e) => slimEntry(e, week)) } })),
    });
    process.stdout.write(`\r${cfg.name}: week ${week} of ${lastWeek}`);
  }
  for (const week of playoffWeeks) {
    const r = await get(`${BASE}/segments/0/leagues/${cfg.id}?view=mRoster&scoringPeriodId=${week}`);
    save(`${cfg.id}-rosters-${week}.json`, {
      teams: r.teams.map((t) => ({ id: t.id, roster: { entries: ((t.roster || {}).entries || []).map((e) => slimEntry(e, week)) } })),
    });
  }
  process.stdout.write('\n');
}

async function main() {
  const pro = await get(`${BASE}?view=proTeamSchedules_wl`);
  save('pro.json', {
    settings: {
      proTeams: pro.settings.proTeams.map((t) => ({
        id: t.id, abbrev: t.abbrev, location: t.location, name: t.name, byeWeek: t.byeWeek,
        proGamesByScoringPeriod: Object.fromEntries(Object.entries(t.proGamesByScoringPeriod || {})
          .filter(([w]) => Number(w) <= finalWeek)
          .map(([w, games]) => [w, games.map((g) => ({
            homeProTeamId: g.homeProTeamId, awayProTeamId: g.awayProTeamId, date: g.date, statsOfficial: g.statsOfficial,
          }))])),
      })),
    },
  });
  for (const cfg of MGDX.LEAGUES) await saveLeague(cfg);
  const env = { ...process.env, MGDX_CONFIG: configFile };
  for (const script of ['run-standings.js', 'run-this-week.js']) {
    execFileSync(process.execPath, [path.join(__dirname, script)], { env, stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
