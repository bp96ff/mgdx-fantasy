// Cross-league schedule: who plays whom each week. Only the pairings come from here; scores, projections and
// lineups come from ESPN. (Named for the Google Sheet the schedule used to be read from.)
(function () {
  const { weekGids } = window.MGDX.CROSS_LEAGUE;
  const { ARCHIVE } = window.MGDX;

  // A past season's pairings were saved with that year's official scores and results (tools/build-history.py):
  //   { weeks: { "1": [{ leagues: [a, b], games: [[ownerA, ownerB]], scores: [[a, b]], results: [["W", "L"]] },
  //                    { bye: true, median: true, games: [[owner, "Median"]], scores: [[null, median]], results: [["W", null]] }] } }
  let archiveFile = null;
  function archiveWeek(week) {
    if (!archiveFile) {
      archiveFile = fetch(`${ARCHIVE.dir}cross.json`).then((r) => {
        if (!r.ok) throw new Error(`Saved cross-league games responded ${r.status}`);
        return r.json();
      });
      archiveFile.catch(() => { archiveFile = null; });
    }
    return archiveFile.then((f) => (f.weeks[week] || []).map((s) => Object.assign({ bye: false, leagues: null }, s)));
  }

  // This season's pairings, saved from the Google Sheet into data/cross-schedule.json (same shape as the
  // Sheet's week tabs gave: [{ bye, leagues: [a, b] | null, games: [[ownerA, ownerB]] }]). The Sheet itself
  // is no longer read. One request for the whole season, kept for the visit.
  let savedFile = null;
  function savedWeek(week) {
    if (!savedFile) {
      savedFile = fetch('data/cross-schedule.json').then((r) => {
        if (!r.ok) throw new Error(`Cross-league schedule responded ${r.status}`);
        return r.json();
      });
      savedFile.catch(() => { savedFile = null; });
    }
    return savedFile.then((f) => (f.weeks[week] || [])
      .map((s) => ({ bye: Boolean(s.bye), leagues: s.leagues ? s.leagues.slice() : null, games: s.games.map((g) => g.slice()) })));
  }

  function getWeek(week) {
    return ARCHIVE ? archiveWeek(week) : savedWeek(week);
  }

  window.SHEET = {
    getWeek,
    weeks: Object.keys(weekGids).map(Number).sort((a, b) => a - b),
  };
})();
