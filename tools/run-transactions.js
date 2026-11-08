#!/usr/bin/env node
// Saves each league's roster moves for the season to data/transactions.json. The Transactions tab reads
// that file and adds anything newer live, so this keeps the tab fast rather than keeping it current.
// Safe to run as often as you like: it only rewrites the file when something changed.
//
//   node tools/run-transactions.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
require('./fetch-retry');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'data', 'transactions.json');
const API = (season, id) => `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${id}`;
const SAME_TIME_MS = 60000;
const NEAR_TRADE_MS = 21 * 86400000; // rosters are end-of-week snapshots, so moves can be well apart in time
const SAME_DEAL_MS = 3 * 86400000;

// The site's data files expect a browser `window`; here it is just the global object.
globalThis.window = globalThis;
for (const file of ['js/config.js', 'js/espn.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
}
const { ESPN, MGDX } = globalThis;

// ESPN doesn't publish a trade's players, so they're worked out from rosters. A player who goes straight
// from one team to another between two weeks, with no matching pickup, was traded. Two checks pin down
// which trade: the team that accepted it, and on the current roster, the approval time stamped on players
// still there. `owners(0)` is the draft, for trades made before the first week's roster.
async function fillInTrade(trade, period, owners, currentRoster, pickups, dropped, claimed) {
  const stamped = {};
  for (const team of currentRoster.teams) {
    for (const e of (team.roster || {}).entries || []) {
      if (e.acquisitionType === 'TRADE' && Math.abs(e.acquisitionDate - trade.date) <= SAME_TIME_MS) {
        (stamped[team.id] = stamped[team.id] || []).push(e.playerId);
      }
    }
  }
  const moves = [];
  for (let p = Math.max(0, trade.period - 1); p <= Math.min(trade.period, period - 1); p++) {
    const before = await owners(p);
    const after = await owners(p + 1);
    for (const [player, to] of after) {
      const from = before.get(player);
      if (!from || from === to) continue;
      const key = `${player}:${from}:${to}:${p}`;
      if (claimed.has(key)) continue;
      // Dropped by one team and picked up by another isn't a trade.
      const near = (a) => a.player === player && Math.abs(a.date - trade.date) < NEAR_TRADE_MS;
      if (pickups.some((a) => near(a) && a.team === to) || dropped.some((a) => near(a) && a.team === from)) continue;
      moves.push({ player, from, to, key });
    }
  }
  // The other team: whoever the stamps name, otherwise whoever swapped the most players with the accepter.
  const accepter = trade.teams[0];
  const stampedOther = Object.keys(stamped).map(Number).find((t) => t !== accepter);
  const tally = {};
  for (const m of moves) {
    if (m.from === accepter) tally[m.to] = (tally[m.to] || 0) + 1;
    if (m.to === accepter) tally[m.from] = (tally[m.from] || 0) + 1;
  }
  const counted = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  const partner = stampedOther || (counted ? Number(counted[0]) : null);
  for (const [t, list] of Object.entries(stamped)) trade.sides[t] = list.slice();
  for (const m of moves) {
    if (partner == null || ![m.from, m.to].every((t) => t === accepter || t === partner)) continue;
    claimed.add(m.key);
    const side = (trade.sides[m.to] = trade.sides[m.to] || []);
    if (!side.includes(m.player)) side.push(m.player);
  }
}

async function main() {
  const period = await ESPN.getCurrentPeriod(MGDX.LEAGUES[0].id);
  const rosters = new Map();
  const rosterAt = (cfg, p) => {
    const key = `${cfg.id}:${p}`;
    if (!rosters.has(key)) rosters.set(key, fetch(`${API(MGDX.SEASON, cfg.id)}?view=mRoster&scoringPeriodId=${p}`).then((r) => r.json()));
    return rosters.get(key);
  };

  const leagues = {};
  const playerIds = new Set();
  let trades = 0;
  for (const cfg of MGDX.LEAGUES) {
    const raw = [];
    for (let p = 1; p <= period; p++) raw.push(...await ESPN.getRawTransactions(cfg.id, p));
    const rows = ESPN.parseTransactions(raw);
    const pickups = rows.filter((r) => r.type !== 'trade').flatMap((r) => r.adds.map((player) => ({ player, team: r.team, date: r.date })));
    const dropped = rows.filter((r) => r.type !== 'trade').flatMap((r) => r.drops.map((player) => ({ player, team: r.team, date: r.date })));
    const claimed = new Set();
    const ownerMaps = new Map();
    const owners = (p) => {
      if (!ownerMaps.has(p)) {
        ownerMaps.set(p, p === 0
          ? fetch(`${API(MGDX.SEASON, cfg.id)}?view=mDraftDetail`).then((r) => r.json())
            .then((d) => new Map(d.draftDetail.picks.map((x) => [x.playerId, x.teamId])))
          : rosterAt(cfg, p).then((d) => new Map(d.teams.flatMap((t) => ((t.roster || {}).entries || []).map((e) => [e.playerId, t.id])))));
      }
      return ownerMaps.get(p);
    };
    const leagueTrades = rows.filter((r) => r.type === 'trade').sort((a, b) => a.date - b.date);
    for (const row of leagueTrades) {
      trades++;
      row.period = raw.find((t) => t.type === 'TRADE_UPHOLD' && t.relatedTransactionId === row.id).scoringPeriodId;
      await fillInTrade(row, period, owners, await rosterAt(cfg, period), pickups, dropped, claimed);
      for (const t of row.teams) row.sides[t] = row.sides[t] || [];
      delete row.period;
    }
    // Two trades close together between the same teams can't always be told apart from weekly rosters.
    // All their players land on the first, so the empty one points to it.
    for (const row of leagueTrades) {
      if (Object.values(row.sides).flat().length) continue;
      const other = leagueTrades.find((o) => o !== row && Math.abs(o.date - row.date) < SAME_DEAL_MS
        && Object.values(o.sides).flat().length && row.teams.some((t) => o.sides[t]));
      if (other) row.seeDate = other.date;
    }
    leagueTrades.forEach((r) => { delete r.teams; });
    leagueTrades.forEach((r) => {
      Object.values(r.sides).flat().forEach((id) => playerIds.add(id));
      r.drops.forEach(([, id]) => playerIds.add(id));
    });
    rows.filter((r) => r.type !== 'trade').forEach((r) => [...r.adds, ...r.drops].forEach((id) => playerIds.add(id)));
    leagues[cfg.slug] = rows;
  }

  const players = await ESPN.getPlayerInfo([...playerIds]);
  for (const cfg of MGDX.LEAGUES) {
    for (const r of leagues[cfg.slug].filter((x) => x.type === 'trade').reverse()) {
      const sides = Object.entries(r.sides).map(([t, l]) => `team ${t} gets ${l.map((id) => (players[id] || [id])[0]).join(', ') || '(none found)'}`);
      console.log(`  ${cfg.name} trade ${new Date(r.date).toISOString().slice(0, 10)}: ${sides.join(' | ')}`);
    }
  }
  const missing = [...playerIds].filter((id) => !players[id]);
  if (missing.length) console.log(`  No player details for: ${missing.join(', ')}`);

  const json = `${JSON.stringify({ season: MGDX.SEASON, lastPeriod: period, leagues, players })}\n`;
  const existing = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
  if (json === existing) {
    console.log('Transactions haven\'t changed. Nothing to do.');
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, json);
  const total = Object.values(leagues).reduce((s, l) => s + l.length, 0);
  console.log(`Saved ${total} transactions, ${trades} trades (${Math.round(json.length / 1024)} KB).`);
}

main().catch((err) => {
  // Leave the last good file in place; the tab pulls anything newer live either way.
  console.error(err);
  process.exit(1);
});
