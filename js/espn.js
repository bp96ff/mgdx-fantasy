// ESPN Fantasy API access + normalization into plain objects the views can render.
// All four leagues are public, so no espn_s2 / SWID cookies are needed.
(function () {
  const { SEASON } = window.MGDX;
  const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}`;

  const SLOTS = {
    0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'BE', 21: 'IR', 23: 'FLEX', 7: 'SFLX',
  };
  // Display order for starters; anything else falls to the end.
  const SLOT_ORDER = [0, 2, 4, 6, 23, 7, 16, 17];
  const POSITIONS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
  const INJURY = { QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'O', INJURY_RESERVE: 'IR', SUSPENSION: 'SSPD' };

  // ---------- fetch with a short in-memory cache ----------
  const cache = new Map();
  async function getJSON(url, ttl = 60000) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < ttl) return hit.p;
    const p = fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
      return r.json();
    });
    cache.set(url, { t: Date.now(), p });
    p.catch(() => cache.delete(url));
    return p;
  }

  // ---------- NFL schedule (byes, kickoffs) ----------
  let proPromise;
  function getProTeams() {
    if (!proPromise) {
      proPromise = getJSON(`${BASE}?view=proTeamSchedules_wl`, 6 * 3600e3).then((d) => {
        const map = {};
        for (const t of d.settings.proTeams) {
          map[t.id] = {
            id: t.id,
            abbrev: t.abbrev,
            name: `${t.location} ${t.name}`.trim(),
            bye: t.byeWeek,
            games: t.proGamesByScoringPeriod || {},
          };
        }
        return map;
      });
      proPromise.catch(() => (proPromise = null));
    }
    return proPromise;
  }

  function nflLogo(abbrev) {
    return abbrev && abbrev !== 'FA'
      ? `https://a.espncdn.com/i/teamlogos/nfl/500/${abbrev.toLowerCase()}.png`
      : '';
  }

  function gameInfo(pro, proTeamId, period) {
    const team = pro[proTeamId];
    if (!team) return { label: 'FA', state: 'none' };
    const g = (team.games[period] || [])[0];
    if (!g) return { label: 'BYE', state: 'bye', team };
    const home = g.homeProTeamId === proTeamId;
    const opp = pro[home ? g.awayProTeamId : g.homeProTeamId];
    let state = 'pre';
    if (g.statsOfficial) state = 'final';
    else if (Date.now() >= g.date) state = 'live';
    return { team, opp, home, date: g.date, state };
  }

  // ---------- League ----------
  function firstName(member) {
    if (!member) return '';
    const n = (member.firstName || member.displayName || '').trim();
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : '';
  }

  async function getLeague(cfg) {
    const { id: leagueId, ownerNames = {}, teamLogos = {}, champions = {}, grandChampions = {}, ultimateLosers = {} } = cfg;
    const d = await getJSON(`${BASE}/segments/0/leagues/${leagueId}?view=mTeam&view=mSettings&view=mMatchupScore`);
    const members = new Map((d.members || []).map((m) => [m.id, m]));
    const currentWeek = d.status.currentMatchupPeriod;
    // ESPN's pointsFor skips bye weeks; we count completed bye-week scores too.
    const byePts = new Map();
    for (const m of d.schedule || []) {
      if (!m.away && m.home && m.matchupPeriodId < currentWeek) {
        byePts.set(m.home.teamId, (byePts.get(m.home.teamId) || 0) + (m.home.totalPoints || 0));
      }
    }
    const teams = d.teams.map((t) => {
      const rec = t.record.overall;
      // Co-owned teams show the secondary owner (the commissioner is primary on some teams).
      const owners = t.owners || [];
      const ownerId = owners.find((o) => o !== t.primaryOwner) || t.primaryOwner || owners[0];
      return {
        id: t.id,
        name: (t.name || `${t.location || ''} ${t.nickname || ''}`).trim() || `Team ${t.id}`,
        abbrev: t.abbrev,
        logo: teamLogos[t.id] || t.logo || '',
        owner: ownerNames[t.id] || firstName(members.get(ownerId)),
        titles: champions[t.id] || [],
        grandTitles: grandChampions[t.id] || 0,
        ultimateLosses: ultimateLosers[t.id] || 0,
        wins: rec.wins, losses: rec.losses, ties: rec.ties,
        pct: rec.percentage,
        pf: rec.pointsFor + (byePts.get(t.id) || 0), pa: rec.pointsAgainst,
        byePf: byePts.get(t.id) || 0,
        streakType: rec.streakType, streakLength: rec.streakLength,
      };
    });
    // League order: win percentage, then PF (bye weeks included). Not ESPN's tiebreakers.
    teams.sort((a, b) => b.pct - a.pct || b.pf - a.pf);
    const sched = d.settings.scheduleSettings;
    return {
      id: leagueId,
      name: d.settings.name,
      size: d.settings.size,
      teams,
      teamById: new Map(teams.map((t) => [t.id, t])),
      playoffTeams: sched.playoffTeamCount,
      slotCounts: d.settings.rosterSettings.lineupSlotCounts,
      regularSeasonWeeks: sched.matchupPeriodCount,
      matchupPeriods: sched.matchupPeriods || {},
      currentWeek: d.status.currentMatchupPeriod,
      currentPeriod: d.scoringPeriodId,
      finalPeriod: d.status.finalScoringPeriod,
    };
  }

  // ---------- Player helpers ----------
  function findStat(stats, source, split, period, seasonId = SEASON) {
    return (stats || []).find(
      (s) => s.statSourceId === source && s.statSplitTypeId === split &&
        (period == null || s.scoringPeriodId === period) && (s.seasonId == null || s.seasonId === seasonId)
    );
  }

  // Short box-score line from raw stat ids.
  function statLine(raw) {
    if (!raw) return '';
    const v = (id) => Math.round(raw[id] || 0);
    const parts = [];
    if (v(0)) parts.push(`${v(3)} Pa Yd`, v(4) ? `${v(4)} Pa TD` : '', v(20) ? `${v(20)} INT` : '');
    if (v(23)) parts.push(`${v(24)} Ru Yd`, v(25) ? `${v(25)} Ru TD` : '');
    if (v(53) || v(58)) parts.push(`${v(53)} Rec`, `${v(42)} Re Yd`, v(43) ? `${v(43)} Re TD` : '');
    if (v(83) || v(85)) parts.push(`${v(83)}/${v(83) + v(85)} FG`);
    return parts.filter(Boolean).slice(0, 4).join(' · ');
  }

  function normalizePlayer(entry, period, pro) {
    const pe = entry.playerPoolEntry || {};
    const p = pe.player || {};
    const pos = POSITIONS[p.defaultPositionId] || '';
    const actualWeek = findStat(p.stats, 0, 1, period);
    const projWeek = findStat(p.stats, 1, 1, period);
    const season = findStat(p.stats, 0, 0, 0);
    const rating = pe.ratings && pe.ratings['0'];
    const isDst = p.defaultPositionId === 16 || p.id < 0;
    const game = gameInfo(pro, p.proTeamId, period);
    const gp = season && season.appliedAverage ? Math.round(season.appliedTotal / season.appliedAverage) : 0;
    // ESPN's rest-of-season projection: source 1 (projected), split 0.
    const ros = findStat(p.stats, 1, 0, 0);
    return {
      id: p.id,
      name: p.fullName || 'Empty',
      pos,
      slotId: entry.lineupSlotId,
      slot: SLOTS[entry.lineupSlotId] || pos,
      starter: entry.lineupSlotId !== 20 && entry.lineupSlotId !== 21,
      injury: INJURY[p.injuryStatus || entry.injuryStatus] || '',
      proTeam: pro[p.proTeamId],
      headshot: isDst
        ? nflLogo(pro[p.proTeamId] && pro[p.proTeamId].abbrev)
        : `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${p.id}.png&w=96&h=70`,
      isDst,
      points: actualWeek ? actualWeek.appliedTotal : 0,
      hasPlayed: !!actualWeek || game.state === 'final' || game.state === 'live',
      proj: projWeek ? projWeek.appliedTotal : 0,
      line: actualWeek ? statLine(actualWeek.stats) : '',
      game,
      seasonRank: rating && rating.positionalRanking ? `${pos}${rating.positionalRanking}` : '—',
      gp,
      fpts: season ? season.appliedTotal : 0,
      ppg: season ? season.appliedAverage || 0 : 0,
      rosAvg: ros ? ros.appliedAverage || 0 : 0,
      rosGames: ros && ros.appliedAverage ? ros.appliedTotal / ros.appliedAverage : 0,
      slots: p.eligibleSlots || [],
      bye: pro[p.proTeamId] ? pro[p.proTeamId].bye : 0,
    };
  }

  function sortLineup(players) {
    const starters = players.filter((p) => p.starter).sort((a, b) => {
      const ia = SLOT_ORDER.indexOf(a.slotId), ib = SLOT_ORDER.indexOf(b.slotId);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const posOrder = ['QB', 'RB', 'WR', 'TE', 'D/ST', 'K'];
    const bench = players.filter((p) => !p.starter).sort((a, b) =>
      (a.slotId === 21) - (b.slotId === 21) || posOrder.indexOf(a.pos) - posOrder.indexOf(b.pos));
    return { starters, bench };
  }

  // ---------- Scoreboard / matchups ----------
  function lastPeriodOf(league, week) {
    const periods = league.matchupPeriods[week] || [week];
    // For the in-progress matchup use the live scoring period, otherwise its final one.
    if (periods.includes(league.currentPeriod)) return league.currentPeriod;
    return periods[periods.length - 1];
  }

  // Normal CDF (Abramowitz–Stegun) for win probability.
  function phi(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function winProb(a, b, decided, winnerSide) {
    if (decided) return winnerSide === 'home' ? 1 : winnerSide === 'away' ? 0 : 0.5;
    const remaining = Math.max(0, a.proj - a.score) + Math.max(0, b.proj - b.score);
    if (remaining < 0.5) return a.score > b.score ? 1 : a.score < b.score ? 0 : 0.5;
    const sigma = 2.2 * Math.sqrt(remaining);
    return Math.min(0.99, Math.max(0.01, phi((a.proj - b.proj) / sigma)));
  }

  function sideFrom(raw, league, period, pro, isCurrent) {
    if (!raw) return null;
    const entries = (raw.rosterForCurrentScoringPeriod || raw.rosterForMatchupPeriod || {}).entries || [];
    const players = entries.map((e) => normalizePlayer(e, period, pro));
    const lineup = players.length ? sortLineup(players) : null;
    const live = raw.totalPointsLive != null ? raw.totalPointsLive : raw.totalPoints || 0;
    const score = isCurrent ? live : (raw.totalPoints || live);
    let proj = raw.totalProjectedPointsLive;
    if (proj == null && lineup) {
      proj = lineup.starters.reduce((s, p) => s + (p.hasPlayed ? p.points : p.proj), 0);
    }
    return {
      team: league.teamById.get(raw.teamId),
      score,
      proj: proj == null ? score : proj,
      lineup,
    };
  }

  async function getMatchups(league, week) {
    const period = lastPeriodOf(league, week);
    const [d, pro] = await Promise.all([
      getJSON(`${BASE}/segments/0/leagues/${league.id}?view=mMatchupScore&view=mScoreboard&scoringPeriodId=${period}`, 30000),
      getProTeams(),
    ]);
    const isCurrent = week === league.currentWeek;
    const games = d.schedule.filter((m) => m.matchupPeriodId === week).map((m) => {
      const home = sideFrom(m.home, league, period, pro, isCurrent);
      const away = sideFrom(m.away, league, period, pro, isCurrent);
      const decided = m.winner && m.winner !== 'UNDECIDED';
      const winner = m.winner === 'HOME' ? 'home' : m.winner === 'AWAY' ? 'away' : m.winner === 'TIE' ? 'tie' : null;
      const started = !!(home && (home.score > 0 || (away && away.score > 0)));
      return {
        id: m.id,
        home, away,
        bye: !away,
        // ESPN never marks a bye "decided", so go by the calendar.
        byeState: week < league.currentWeek ? 'final' : isCurrent ? 'live' : 'upcoming',
        decided, winner, started,
        playoff: m.playoffTierType && m.playoffTierType !== 'NONE',
        prob: away ? winProb(home, away, decided, winner) : null,
      };
    });
    return { week, period, games, isCurrent, upcoming: week > league.currentWeek };
  }

  // Results for every team across the season (for Last 5 and team schedules).
  async function getResults(league) {
    const d = await getJSON(`${BASE}/segments/0/leagues/${league.id}?view=mMatchupScore`, 120000);
    const byTeam = new Map(league.teams.map((t) => [t.id, []]));
    for (const m of d.schedule) {
      const sides = [['home', m.home, m.away], ['away', m.away, m.home]];
      for (const [side, me, opp] of sides) {
        if (!me || !byTeam.has(me.teamId)) continue;
        let result = null;
        if (m.winner && m.winner !== 'UNDECIDED') {
          result = m.winner === 'TIE' ? 'T' : m.winner.toLowerCase() === side ? 'W' : 'L';
        }
        byTeam.get(me.teamId).push({
          id: m.id,
          week: m.matchupPeriodId,
          opp: opp ? league.teamById.get(opp.teamId) : null,
          bye: !opp,
          pf: me.totalPoints || 0,
          pa: opp ? opp.totalPoints || 0 : 0,
          result,
        });
      }
    }
    for (const list of byTeam.values()) list.sort((a, b) => a.week - b.week);
    return byTeam;
  }

  // Past weeks return that week's actual lineup; future weeks return the current roster with that week's projections.
  async function getRosters(league, week = league.currentWeek) {
    const period = lastPeriodOf(league, week);
    const [d, pro] = await Promise.all([
      getJSON(`${BASE}/segments/0/leagues/${league.id}?view=mRoster&scoringPeriodId=${period}`, 120000),
      getProTeams(),
    ]);
    const map = new Map();
    for (const t of d.teams) {
      const players = ((t.roster || {}).entries || []).map((e) => normalizePlayer(e, period, pro));
      map.set(t.id, sortLineup(players));
    }
    return { week, period, byTeam: map };
  }

  // The cheapest way to ask ESPN what week it is (about 1 KB).
  async function getCurrentWeek(leagueId) {
    const d = await getJSON(`${BASE}/segments/0/leagues/${leagueId}?view=mStatus`);
    return d.status.currentMatchupPeriod;
  }

  async function getCurrentPeriod(leagueId) {
    const d = await getJSON(`${BASE}/segments/0/leagues/${leagueId}?view=mStatus`);
    return d.scoringPeriodId;
  }

  // ---------- Transactions ----------
  async function getRawTransactions(leagueId, period) {
    const d = await getJSON(`${BASE}/segments/0/leagues/${leagueId}?view=mTransactions2&scoringPeriodId=${period}`);
    return d.transactions || [];
  }

  // ESPN's raw list -> completed roster moves, newest first. ESPN doesn't publish which players moved
  // in a trade, so trades come back with `sides` empty (tools/run-transactions.js fills them in).
  //   move:  { id, date, type: 'add'|'drop'|'waiver', team, adds: [playerId], drops: [playerId] }
  //   trade: { id, date, type: 'trade', teams: [teamId], sides: { teamId: [playerId] }, drops: [[teamId, playerId]] }
  function parseTransactions(raw) {
    const unique = [...new Map(raw.map((t) => [t.id, t])).values()];
    const ids = (t, type) => (t.items || []).filter((i) => i.type === type).map((i) => i.playerId);
    const rows = [];
    for (const t of unique) {
      if (t.status !== 'EXECUTED' || !['FREEAGENT', 'WAIVER', 'ROSTER'].includes(t.type)) continue;
      const adds = ids(t, 'ADD');
      const drops = ids(t, 'DROP');
      if (!adds.length && !drops.length) continue; // lineup changes
      rows.push({
        id: t.id,
        date: t.processDate || t.proposedDate,
        type: t.type === 'WAIVER' ? 'waiver' : adds.length ? 'add' : 'drop',
        team: t.teamId,
        adds,
        drops,
      });
    }
    // A trade happened if it was accepted and approved; the approval is when players changed teams.
    for (const up of unique.filter((t) => t.type === 'TRADE_UPHOLD')) {
      const accepts = unique.filter((t) => t.type === 'TRADE_ACCEPT' && t.relatedTransactionId === up.relatedTransactionId);
      rows.push({
        id: up.relatedTransactionId,
        date: up.proposedDate,
        type: 'trade',
        teams: accepts.map((a) => a.teamId),
        sides: {},
        drops: accepts.flatMap((a) => ids(a, 'DROP').map((p) => [a.teamId, p])),
      });
    }
    return rows.sort((a, b) => b.date - a.date);
  }

  // Name, position and NFL team for a list of players: { id: [name, pos, team] }.
  async function getPlayerInfo(playerIds) {
    const pro = await getProTeams();
    const out = {};
    for (let i = 0; i < playerIds.length; i += 200) {
      const r = await fetch(`${BASE}/players?view=players_wl`, {
        headers: { 'X-Fantasy-Filter': JSON.stringify({ filterIds: { value: playerIds.slice(i, i + 200) } }) },
      });
      if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
      for (const p of await r.json()) {
        out[p.id] = [p.fullName, POSITIONS[p.defaultPositionId] || '', pro[p.proTeamId] ? pro[p.proTeamId].abbrev : 'FA'];
      }
    }
    return out;
  }

  window.ESPN = {
    getLeague, getMatchups, getResults, getRosters, getCurrentWeek, getCurrentPeriod,
    getRawTransactions, parseTransactions, getPlayerInfo, nflLogo, winProb,
  };
})();
