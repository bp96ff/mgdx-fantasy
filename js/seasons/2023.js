// The 2023 season page (2023.html): the same site, run from files saved in data/seasons/2023/ instead of
// live ESPN and Google Sheets data. Built by tools/build-season.js; nothing here changes after that.
window.MGDX = {
  SEASON: 2023,
  LIVE_REFRESH_MS: 0,
  // Past season: every page reads its saved files. lastWeek is the final regular-season week; the playoffs
  // come from the league's own bracket in playoffs.json, not ESPN's.
  // playoffWeeks have saved lineups only (the bracket's games and scores are in playoffs.json).
  ARCHIVE: { dir: 'data/seasons/2023/', lastWeek: 14, playoffWeeks: [15, 16, 17] },
  // The cross-league weeks saved in data/seasons/2023/cross.json.
  CROSS_LEAGUE: { weekGids: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 13: 0, 14: 0 } },
  LEAGUES: [
    {
      slug: 'lab-rats',
      name: 'Lab Rats',
      id: 1014280149,
      logo: 'assets/img/lab-rats.png',
      art: 'assets/img/lab-rats-alt-crop.jpg',
      badge: 'assets/img/champs/lab-rats.png?v=2',
      theme: 'lr',
      // Team names as the league's standings sheet listed them, by ESPN teamId.
      teamNames: { 2: 'not them boys' },
    },
    {
      slug: 'molecular-mice',
      name: 'Molecular Mice',
      id: 424269265,
      logo: 'assets/img/molecular-mice.png?v=2',
      art: 'assets/img/molecular-mice-alt.jpg',
      badge: 'assets/img/champs/molecular-mice.png?v=2',
      theme: 'mm',
      // Kayla and Darbie played 2023 on other ESPN accounts.
      ownerNames: { 7: 'Kayla', 9: 'Darbie' },
      teamNames: {
        1: 'Putting on her Floaties', 3: 'Not last.... please? 🤞🏼', 4: 'Nah uh, seb stinks', 6: "I'm ded but I'm alive",
        7: "Pack n' Play", 9: 'Kira Stinks',
      },
    },
  ],
};
