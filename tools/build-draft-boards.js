#!/usr/bin/env node
// Builds data/draft-boards.json, the saved table behind each league's Draft Board tab. Run once after
// the draft (a draft doesn't change): node tools/build-draft-boards.js
//
// Picks and player details come from ESPN. BOARD_COLUMNS and CORRECTIONS come from the photos of the
// physical boards in Media/, which win wherever they disagree with ESPN.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The site's config and ESPN code expect a browser `window`; here it is just the global object.
globalThis.window = globalThis;
for (const file of ['js/config.js', 'js/espn.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { filename: file });
}
const { MGDX, ESPN } = globalThis;

const SEASON = MGDX.SEASON;
const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}`;
// Team ids left to right, as on each board.
const BOARD_COLUMNS = {
  'lab-rats': [3, 2, 1, 5, 4, 12, 7, 11, 6], // Nick, Trace, Bryce, Julia, Rocio, Marsha, Celina, Karen, Ryan
  'molecular-mice': [10, 1, 4, 3, 8, 7, 5, 9, 2], // Courtney, Kat, Jana, Sidney, Jonathan (Destiny), Kayla, Xenia, Amanda, Sarah
  'genomic-gerbils': [1, 2, 7, 8, 3, 4, 9, 6, 5], // Laith, Purcella, Alan, Tisha, Darbie, Haley, Sloan, Jen, Daniel
  'research-rodents': [2, 4, 7, 1, 3, 5, 8, 6, 9], // Ciana, Tiffany, Jenna, Emma, Jake, Dago, Craig, Hoai-Nha, Darcy
};
// Picks to change from ESPN's record, e.g. { league: 'lab-rats', team: 3, round: 16, player: 'Full Name' }.
// Known board differences where ESPN is kept: Lab Rats, Nick, round 16 is blank on the board (ESPN: Kenyon Sadiq);
// Genomic Gerbils, Alan, round 11 reads Malik Washington on the board (Parker Washington confirmed as correct).
const CORRECTIONS = [];
const POSITIONS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

const getJSON = async (url, headers = {}) => {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`ESPN responded ${r.status} for ${url}`);
  return r.json();
};

async function main() {
  const pro = await getJSON(`${BASE}?view=proTeamSchedules_wl`);
  const abbrev = new Map(pro.settings.proTeams.map((t) => [t.id, t.abbrev]));
  const raw = await getJSON(`${BASE}/players?view=kona_player_info&scoringPeriodId=0`, {
    'X-Fantasy-Filter': JSON.stringify({ players: { limit: 20000 } }),
    'x-fantasy-platform': 'kona',
    'x-fantasy-source': 'kona',
  });
  const byId = new Map(raw.map((p) => [p.id, p]));
  const byName = new Map(raw.map((p) => [p.fullName, p]));
  const entry = (p) => ({ id: p.id, name: p.fullName, pos: POSITIONS[p.defaultPositionId] || '', team: abbrev.get(p.proTeamId) || 'FA' });

  const leagues = {};
  for (const cfg of MGDX.LEAGUES) {
    const slug = cfg.slug;
    const d = await getJSON(`${BASE}/segments/0/leagues/${cfg.id}?view=mDraftDetail`);
    // Owner names (with the config's name changes) and logos, so the tab needs no live league data.
    const league = await ESPN.getLeague(cfg);
    const teams = Object.fromEntries(league.teams.map((t) => [t.id, { name: t.name, owner: t.owner, logo: t.logo }]));
    const picks = {};
    let rounds = 0;
    for (const pick of d.draftDetail.picks) {
      const player = byId.get(pick.playerId);
      if (!player) throw new Error(`No player found for id ${pick.playerId}`);
      (picks[pick.teamId] = picks[pick.teamId] || [])[pick.roundId - 1] = entry(player);
      rounds = Math.max(rounds, pick.roundId);
    }
    for (const fix of CORRECTIONS.filter((c) => c.league === slug)) {
      const player = byName.get(fix.player);
      if (!player) throw new Error(`No player named ${fix.player}`);
      picks[fix.team][fix.round - 1] = entry(player);
    }
    leagues[slug] = { rounds, columns: BOARD_COLUMNS[slug], teams, picks };
  }
  const out = path.join(__dirname, '..', 'data', 'draft-boards.json');
  fs.writeFileSync(out, `${JSON.stringify({ season: SEASON, leagues })}\n`);
  console.log(`Saved ${Object.keys(leagues).length} draft boards (${fs.statSync(out).size} bytes).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
