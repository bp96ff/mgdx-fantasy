#!/usr/bin/env node
// Works out the Tuesday-morning notifications for the week that just finished, into data/weekly-notes.json.
// The push function (supabase/functions/push, action "weekly") reads that file from the live site and sends it
// at 9 AM Central on Tuesday, once per week; see the weekly-notes timer in supabase/schema.sql.
//
//   node tools/run-weekly-notes.js            the week that just finished (ESPN's current week minus one)
//   node tools/run-weekly-notes.js 9          a given week, to check what it would have said (prints, saves nothing)
//
// Everything comes from the saved files the site uses: this season's games.json and standings.json, and past
// seasons' games.json and playoffs.json. Regular season only (Weeks 1-14).
//
// weekly-notes.json: { season, week, teams: { "league:teamId": { result: { title, body }, url, race } },
//   records: { title, body } | null }
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUTPUT = path.join(DATA, 'weekly-notes.json');
const LAST_REGULAR_WEEK = 14;
const BUBBLE_FROM_WEEK = 9; // as the Bubble Spotlight tag on Matchups
const BUBBLE_GAMES = 2;
const TOP = 10;

const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const f2 = (n) => n.toFixed(2);
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const plural = (n, word) => `${n % 1 ? n.toFixed(1) : n} ${word}${n === 1 ? '' : 's'}`;
const LEAGUE_NAMES = { 'lab-rats': 'Lab Rats', 'molecular-mice': 'Molecular Mice', 'genomic-gerbils': 'Genomic Gerbils', 'research-rodents': 'Research Rodents' };

// ---------- shared with the site (js/app.js): weekly scores, streaks, margins ----------
function teamWeeks(file, through = Infinity) {
  const by = new Map();
  for (const [week, a, sa, b, sb] of file.games) {
    if (week > through) continue;
    for (const [key, pf, pa, opp] of b === 'median' ? [[a, sa, sb, null]] : [[a, sa, sb, b], [b, sb, sa, a]]) {
      const id = `${key}|${week}`;
      if (!by.has(id)) by.set(id, { key, week, pf, games: [] });
      by.get(id).games.push({ result: pf > pa ? 'W' : pf < pa ? 'L' : 'T', pf, pa, opp, inLeague: null });
    }
  }
  // in-league game first each week (the site's games list has it first, and links say which is which)
  for (const [week, a, , b, , link] of file.games) {
    if (week > through) continue;
    for (const key of [a, b]) {
      const w = by.get(`${key}|${week}`);
      const g = w && w.games.find((x) => x.inLeague === null && x.opp === (key === a ? (b === 'median' ? null : b) : a));
      if (g) g.inLeague = link.includes('/matchups');
    }
  }
  return [...by.values()];
}
function seasonRuns(weeks, through = Infinity) {
  const runs = [];
  const byTeam = new Map();
  for (const w of weeks) if (w.week <= through) (byTeam.get(w.key) || byTeam.set(w.key, []).get(w.key)).push(w);
  for (const [key, list] of byTeam) {
    list.sort((x, y) => x.week - y.week);
    let run = null;
    for (const w of list) {
      for (const g of w.games.slice().sort((x, y) => y.inLeague - x.inLeague)) {
        if (run && run.result === g.result) { run.n++; run.end = w.week; continue; }
        if (run) runs.push(run);
        run = g.result === 'T' ? null : { key, result: g.result, n: 1, end: w.week };
      }
    }
    if (run) runs.push(run);
  }
  return runs;
}
const margins = (file, through = Infinity) => file.games.filter((g) => g[3] !== 'median' && g[0] <= through)
  .map(([week, a, sa, b, sb]) => ({ week, a, b, sa, sb, margin: Math.round(Math.abs(sa - sb) * 100) / 100 }));

// ---------- the week ----------
function build(week, { games, standings, past }) {
  const names = games.teams; // key -> [team name, owner]
  const owner = (key) => (names[key] ? names[key][1] : key);
  const weeks = teamWeeks(games, week);
  const thisWeek = weeks.filter((w) => w.week === week);
  const teams = {};

  // Final results: one line per game, in-league first.
  for (const w of thisWeek) {
    const list = w.games.slice().sort((x, y) => y.inLeague - x.inLeague);
    const won = list.filter((g) => g.result === 'W').length;
    const lost = list.filter((g) => g.result === 'L').length;
    const tied = list.length - won - lost;
    const lines = list.map((g) => {
      const verb = g.result === 'W' ? 'Beat' : g.result === 'L' ? 'Lost to' : 'Tied';
      const [hi, lo] = g.result === 'L' ? [g.pa, g.pf] : [g.pf, g.pa];
      return `${verb} ${g.opp ? owner(g.opp) : 'the median'} ${f2(hi)}–${f2(lo)}${g.inLeague ? '' : ' (cross-league)'}`;
    });
    teams[w.key] = {
      result: { title: `Week ${week} final: you went ${won}-${lost}${tied ? `-${tied}` : ''}`, body: `You scored ${f2(w.pf)}. ${lines.join('. ')}.` },
      url: `#/${w.key.split(':')[0]}/matchups?week=${week}&team=${w.key.split(':')[1]}`,
    };
  }

  // Playoff race: each league's table after the week (overall win %, then PF), and what can still happen.
  const tableThrough = (slug, w) => {
    const rows = new Map();
    for (const x of teamWeeks(games, w)) {
      if (!x.key.startsWith(`${slug}:`)) continue;
      const r = rows.get(x.key) || rows.set(x.key, { key: x.key, w: 0, l: 0, t: 0, pf: 0 }).get(x.key);
      r.pf += x.pf;
      for (const g of x.games) r[g.result === 'W' ? 'w' : g.result === 'L' ? 'l' : 't']++;
    }
    const list = [...rows.values()].map((r) => Object.assign(r, { pts: r.w + r.t / 2, n: r.w + r.l + r.t }));
    list.sort((a, b) => (b.pts / b.n) - (a.pts / a.n) || b.pf - a.pf);
    return list;
  };
  const statusOf = (list, spots, w) => {
    const left = Math.max(0, LAST_REGULAR_WEEK - w) * 2; // two games a week
    return new Map(list.map((r, i) => {
      const others = list.filter((o) => o !== r);
      // Clinched: fewer than `spots` other teams could still finish level with or ahead of this team's floor.
      const clinched = others.filter((o) => o.pts + left >= r.pts).length < spots;
      // Eliminated: at least `spots` teams are already out of reach, even if this team wins out.
      const out = others.filter((o) => o.pts > r.pts + left).length >= spots;
      return [r.key, { place: i + 1, clinched, out }];
    }));
  };
  for (const [slug, league] of Object.entries(standings.leagues)) {
    const spots = league.playoffTeams;
    if (!spots) continue;
    const now = tableThrough(slug, week);
    const before = tableThrough(slug, week - 1);
    const s = statusOf(now, spots, week);
    const s0 = week > 1 ? statusOf(before, spots, week - 1) : new Map();
    const lastIn = now[spots - 1];
    const firstOut = now[spots];
    const name = LEAGUE_NAMES[slug] || slug;
    now.forEach((r, i) => {
      const me = s.get(r.key);
      const was = s0.get(r.key) || {};
      let race = '';
      if (week === LAST_REGULAR_WEEK) {
        race = i < spots ? `You made the playoffs as the ${ordinal(i + 1)} seed in ${name}.` : `You finished ${ordinal(i + 1)} in ${name} and missed the playoffs.`;
      } else if (me.clinched && !was.clinched) {
        race = `You’ve clinched a playoff spot in ${name}!`;
      } else if (me.out && !was.out) {
        race = `You’re out of the playoff race in ${name}.`;
      } else if (!me.clinched && !me.out && week + 1 >= BUBBLE_FROM_WEEK && firstOut) {
        const gap = i < spots
          ? (r.pts - firstOut.pts + (firstOut.n - firstOut.pts) - (r.n - r.pts)) / 2
          : (lastIn.pts - r.pts + (r.n - r.pts) - (lastIn.n - lastIn.pts)) / 2;
        if (gap <= BUBBLE_GAMES) {
          const where = gap === 0 ? 'right on the playoff line'
            : i < spots ? `${plural(gap, 'game')} ahead of the first team out` : `${plural(gap, 'game')} behind the last playoff spot`;
          race = `You’re on the bubble heading into Week ${week + 1}: ${ordinal(i + 1)} in ${name}, ${where}.`;
        }
      }
      if (race && teams[r.key]) teams[r.key].race = race;
    });
  }

  // Records: anything from this week that's in the all-time top 10 of a Records list.
  const prior = { scores: [], weeks: [], runs: [], margins: [] };
  for (const { games: g, playoffs } of past) {
    if (g) {
      const w = teamWeeks(g);
      prior.weeks.push(...w);
      prior.scores.push(...w.map((x) => x.pf));
      prior.runs.push(...seasonRuns(w));
      prior.margins.push(...margins(g).map((m) => m.margin));
    }
    if (playoffs) for (const pg of playoffs.games) for (const t of pg.teams) prior.scores.push(t.score);
  }
  const earlier = weeks.filter((w) => w.week < week);
  const has = (w, r) => w.games.some((g) => g.result === r);
  const swept = (w, r) => w.games.length >= 2 && w.games.every((g) => g.result === r);
  const rankAmong = (value, others, better) => 1 + others.filter((v) => better(v, value)).length;
  const high = (v, x) => v > x;
  const low = (v, x) => v < x;
  const items = [];
  // test null: every score counts (past seasons' playoff games too); otherwise only weeks that pass it
  const scoreList = (words, test, better) => {
    const pool = test ? prior.weeks.concat(earlier).filter(test).map((w) => w.pf) : prior.scores.concat(earlier.map((w) => w.pf));
    const mine = thisWeek.filter(test || (() => true));
    for (const w of mine) {
      const rank = rankAmong(w.pf, pool.concat(mine.filter((o) => o !== w).map((o) => o.pf)), better);
      if (rank <= TOP) items.push({ rank, text: `${owner(w.key)}’s ${f2(w.pf)}`, words });
    }
  };
  scoreList('highest score', null, high);
  scoreList('lowest score', null, low);
  scoreList('most points in a loss', (w) => has(w, 'L'), high);
  scoreList('fewest points in a win', (w) => has(w, 'W'), low);
  scoreList('most points in an 0-2 week', (w) => swept(w, 'L'), high);
  scoreList('fewest points in a 2-0 week', (w) => swept(w, 'W'), low);
  const allMargins = prior.margins.concat(margins(games, week - 1).map((m) => m.margin));
  const mineMargins = margins(games, week).filter((m) => m.week === week);
  for (const [words, better] of [['biggest blowout', high], ['closest game', low]]) {
    for (const m of mineMargins) {
      const rank = rankAmong(m.margin, allMargins.concat(mineMargins.filter((o) => o !== m).map((o) => o.margin)), better);
      if (rank > TOP) continue;
      const [win, lose] = m.sa >= m.sb ? [m.a, m.b] : [m.b, m.a];
      items.push({ rank, words, text: m.margin ? `${owner(win)} beating ${owner(lose)} by ${f2(m.margin)}` : `${owner(m.a)} and ${owner(m.b)} tying` });
    }
  }
  // Streaks: a run still going after this week, when it enters the top 10 (or takes over first).
  const runsNow = seasonRuns(weeks, week);
  const runsBefore = seasonRuns(weeks, week - 1);
  for (const [letter, words] of [['W', 'longest winning streak'], ['L', 'longest losing streak']]) {
    const past = prior.runs.filter((r) => r.result === letter).map((r) => r.n);
    for (const run of runsNow.filter((r) => r.result === letter && r.end === week)) {
      const others = (list, self) => past.concat(list.filter((r) => r.result === letter && r !== self).map((r) => r.n));
      const rank = rankAmong(run.n, others(runsNow, run), high);
      const prev = runsBefore.find((r) => r.key === run.key && r.result === letter && r.end === week - 1);
      const was = prev ? rankAmong(prev.n, others(runsBefore, prev), high) : Infinity;
      if (rank <= TOP && (was > TOP || (rank === 1 && was > 1))) items.push({ rank, words, text: `${owner(run.key)}’s ${run.n}-game ${letter === 'W' ? 'winning' : 'losing'} streak` });
    }
  }
  items.sort((a, b) => a.rank - b.rank);
  const line = (x) => `${x.text}: the ${x.rank === 1 ? '' : `${ordinal(x.rank)}-`}${x.words} ever.`;
  const records = items.length ? {
    title: items.some((x) => x.rank === 1) ? `Week ${week}: a new all-time record!` : `Week ${week}: ${items.length === 1 ? 'a new top-10 record' : `${items.length} new top-10 records`}`,
    body: items.map(line).join(' '),
  } : null;

  return { season: games.season, week, teams, records };
}

function load() {
  const games = read(path.join(DATA, 'games.json'));
  const standings = read(path.join(DATA, 'standings.json'));
  const seasonsDir = path.join(DATA, 'seasons');
  const past = fs.existsSync(seasonsDir) ? fs.readdirSync(seasonsDir).filter((y) => /^\d{4}$/.test(y) && Number(y) < (games && games.season))
    .map((y) => ({ games: read(path.join(seasonsDir, y, 'games.json')), playoffs: read(path.join(seasonsDir, y, 'playoffs.json')) })) : [];
  return { games, standings, past };
}

function main() {
  const data = load();
  const { games, standings } = data;
  if (!games || !standings || games.season !== standings.season) throw new Error('games.json and standings.json are missing or from different seasons');
  const asked = Number(process.argv[2]);
  const week = asked || standings.week - 1;
  if (!(week >= 1 && week <= LAST_REGULAR_WEEK)) return console.log(`Week ${week}: outside the regular season; nothing to write.`);
  // Only a finished week: every team has its games for it.
  const played = new Set(teamWeeks(games, week).filter((w) => w.week === week).map((w) => w.key));
  if (played.size < Object.keys(games.teams).length) return console.log(`Week ${week} isn't fully saved yet (${played.size} teams); nothing to write.`);
  const notes = build(week, data);
  if (asked) return console.log(JSON.stringify(notes, null, 1));
  const text = JSON.stringify(notes, null, 1) + '\n';
  if (fs.existsSync(OUTPUT) && fs.readFileSync(OUTPUT, 'utf8') === text) return console.log(`Week ${week} notes unchanged.`);
  fs.writeFileSync(OUTPUT, text);
  console.log(`Saved Week ${week} notes: ${Object.keys(notes.teams).length} teams, ${notes.records ? 'records' : 'no records'}.`);
}

if (require.main === module) main();
module.exports = { build, load };
