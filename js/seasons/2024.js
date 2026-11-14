// The 2024 season page (2024.html): the same site, run from files saved in data/seasons/2024/ instead of
// live ESPN and Google Sheets data. Built by tools/build-season.js; nothing here changes after that.
window.MGDX = {
  SEASON: 2024,
  LIVE_REFRESH_MS: 0,
  // Past season: every page reads its saved files. lastWeek is the final regular-season week; the playoffs
  // come from the league's own bracket in playoffs.json, not ESPN's.
  // playoffWeeks have saved lineups only (the bracket's games and scores are in playoffs.json).
  // 2024 had four leagues of eight, so nobody had a bye week; the finals were four-team games, one team per league.
  ARCHIVE: { dir: 'data/seasons/2024/', lastWeek: 14, playoffWeeks: [15, 16, 17] },
  // The cross-league weeks saved in data/seasons/2024/cross.json.
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
      // The league's names for these ESPN accounts, by teamId. Team 1 was Emma's, co-managed by the commissioner.
      ownerNames: { 1: 'Emma', 2: 'Trace', 6: 'Sloan' },
    },
    {
      slug: 'molecular-mice',
      name: 'Molecular Mice',
      id: 424269265,
      logo: 'assets/img/molecular-mice.png?v=2',
      art: 'assets/img/molecular-mice-alt.jpg',
      badge: 'assets/img/champs/molecular-mice.png?v=2',
      theme: 'mm',
      // Team 1 was Andrew's, co-managed by the commissioner.
      ownerNames: { 1: 'Andrew', 3: 'RJ', 7: 'Kayla', 9: 'Darbie' },
    },
    {
      slug: 'genomic-gerbils',
      name: 'Genomic Gerbils',
      id: 198075491,
      logo: 'assets/img/genomic-gerbils.jpg',
      art: 'assets/img/genomic-gerbils-alt-crop.jpg',
      badge: 'assets/img/champs/genomic-gerbils.png?v=2',
      theme: 'gg',
      // Team 1 was David's, co-managed by the commissioner.
      ownerNames: { 1: 'David' },
    },
    {
      slug: 'research-rodents',
      name: 'Research Rodents',
      id: 459077645,
      logo: 'assets/img/research-rodents.png',
      art: 'assets/img/research-rodents-alt-crop.jpg',
      badge: 'assets/img/champs/research-rodents.png?v=2',
      theme: 'rr',
    },
  ],
};
