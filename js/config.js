// Site configuration. Change SEASON each year; add or edit leagues here.
window.MGDX = {
  SEASON: 2026,
  // How often (ms) the current week's matchups refresh while the page is open.
  LIVE_REFRESH_MS: 60000,
  // Cross-league schedule: the pairings are saved in data/cross-schedule.json (from the old Google Sheet, which
  // the site no longer reads). weekGids' week numbers are the weeks with cross-league games; the gids are the
  // Sheet tabs they came from.
  CROSS_LEAGUE: {
    sheetId: '1a8lCw8MYyGMoS5mHOOmkPIZP976QCEInzlGomA_WQaE',
    weekGids: {
      1: 818179348, 2: 426930594, 3: 1261831829, 4: 773511212, 5: 1904497790,
      6: 1651718310, 7: 754717688, 8: 67147074, 9: 1415644860, 10: 1905091393,
      11: 390406565, 12: 1772889291, 13: 764862361, 14: 1110700489,
    },
  },
  // Manager accounts (js/account.js). From Supabase: the Project URL and the publishable key
  // (sb_publishable_...). That key is meant to be public; what it can do is limited by supabase/schema.sql.
  // Leave both blank to turn sign-in off.
  SUPABASE: {
    url: 'https://blfbdmrnrwvylvqakgck.supabase.co',
    anonKey: 'sb_publishable_YgYOVZ69vU8LUPqhHvN7YQ_RJdv64e_',
  },
  // GIF search on the Main Blog (developers.giphy.com). Like the key above, it's meant to be public.
  // Empty hides the GIF button; photo and GIF uploads still work.
  GIPHY_KEY: 'tRWl9lrgSEBo2Nq2UenJLzpI0gQsoCu7',
  LEAGUES: [
    {
      slug: 'lab-rats',
      name: 'Lab Rats',
      id: 1014280149,
      logo: 'assets/img/lab-rats.png',
      art: 'assets/img/lab-rats-alt-crop.jpg',
      badge: 'assets/img/champs/lab-rats.png?v=2',
      theme: 'lr',
      ownerNames: { 2: 'Trace' }, // Cooking em
      // Override the logo ESPN reports, by teamId. Needed for custom uploads, which ESPN only serves to logged-in users.
      teamLogos: { 1: 'assets/img/teams/divine-intervention.jpg' }, // Divine Intervention
      // Past titles shown as small logos by the owner's name: teamId -> one league slug per title.
      // A title can be from a different league than the team plays in now; repeat a slug for repeat wins.
      champions: {
        1: ['lab-rats'], // Bryce (Divine Intervention)
        2: ['lab-rats'], // Trace (Cooking em)
        3: ['lab-rats'], // Nick (Regulatory Red Flags)
      },
      // Former grand champions (golden goat): teamId -> number of grand championships.
      grandChampions: { 1: 1 }, // Bryce (Divine Intervention)
    },
    {
      slug: 'molecular-mice',
      name: 'Molecular Mice',
      id: 424269265,
      logo: 'assets/img/molecular-mice.png?v=2',
      art: 'assets/img/molecular-mice-alt.jpg',
      badge: 'assets/img/champs/molecular-mice.png?v=2',
      theme: 'mm',
      // Override the owner name ESPN reports, by teamId.
      ownerNames: { 7: 'Kayla' }, // Say CHEESE!
      champions: {
        2: ['molecular-mice'], // Sarah (Sarah's Smart Team)
        7: ['molecular-mice'], // Kayla (Say CHEESE!)
      },
      grandChampions: { 2: 1 }, // Sarah (Sarah's Smart Team)
      // Former ultimate losers (golden plunger): teamId -> number of times.
      ultimateLosers: { 9: 1 }, // Amanda (Amanda's Astounding Team)
    },
    {
      slug: 'genomic-gerbils',
      name: 'Genomic Gerbils',
      id: 198075491,
      logo: 'assets/img/genomic-gerbils.jpg',
      art: 'assets/img/genomic-gerbils-alt-crop.jpg',
      badge: 'assets/img/champs/genomic-gerbils.png?v=2',
      theme: 'gg',
      ownerNames: { 6: 'Jen', 9: 'Sloan' }, // Jen's Team, the End of YoRHa
      champions: {
        8: ['genomic-gerbils', 'genomic-gerbils'], // Tisha (TNT), two titles
      },
      grandChampions: { 8: 1 }, // Tisha (TNT)
    },
    {
      slug: 'research-rodents',
      name: 'Research Rodents',
      id: 459077645,
      logo: 'assets/img/research-rodents.png',
      art: 'assets/img/research-rodents-alt-crop.jpg',
      badge: 'assets/img/champs/research-rodents.png?v=2',
      theme: 'rr',
      ownerNames: { 5: 'Dago' }, // Taylor Gang
      champions: {
        1: ['molecular-mice', 'research-rodents'], // Emma (Hail Mary Pass), won Molecular Mice before moving here
        3: ['research-rodents'], // Jake (Prestige Worldwide)
      },
      ultimateLosers: { 6: 1 }, // Hoai-Nha (Hoai-Nha's Bro Dudes)
    },
  ],
};
