// Cross-league schedule from the public Google Sheet. Only the pairings are read from
// the sheet; scores, projections and lineups come from ESPN.
(function () {
  const { sheetId, weekGids } = window.MGDX.CROSS_LEAGUE;
  const cache = new Map();

  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Week tab layout:
  //   "Lab Rats",,,,,,"Molecular Mice"        <- section header (two league names)
  //   Result,Team,Current,Projected,Final,,…  <- column headings (skipped)
  //   W,Nick,…,vs,…,Courtney,L                <- matchup: names in columns B and J
  //   "Bye Weeks"                             <- bye section; leagues come from ESPN
  function parseWeek(rows) {
    const sections = [];
    let cur = null;
    for (const raw of rows) {
      const c = raw.map((s) => (s || '').trim());
      if ((c[5] || '').toLowerCase() === 'vs') {
        if (cur && c[1] && c[9]) cur.games.push([c[1], c[9]]);
        continue;
      }
      if (c[0] && !c[1] && /bye/i.test(c[0])) {
        cur = { bye: true, leagues: null, games: [] };
        sections.push(cur);
      } else if (c[0] && !c[1] && c[6]) {
        cur = { bye: false, leagues: [c[0], c[6]], games: [] };
        sections.push(cur);
      }
    }
    return sections.filter((s) => s.games.length);
  }

  function getWeek(week) {
    const gid = weekGids[week];
    if (gid == null) return Promise.resolve([]);
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < 60000) return hit.p;
    const p = fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`Google Sheets responded ${r.status}`);
      return r.text();
    }).then((t) => parseWeek(parseCSV(t)));
    cache.set(url, { t: Date.now(), p });
    p.catch(() => cache.delete(url));
    return p;
  }

  window.SHEET = {
    getWeek,
    weeks: Object.keys(weekGids).map(Number).sort((a, b) => a - b),
  };
})();
