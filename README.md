# Microgen Fantasy Football website

Static site (HTML/CSS/JS, no build step) that pulls live data from ESPN Fantasy in the visitor's browser.

## Files
- `index.html` – page shell and main navigation
- `css/styles.css` – theme; league colors are the `--lr`, `--mm`, `--gg`, `--rr` tokens at the top
- `js/config.js` – season, league IDs, logos, live-refresh interval
- `js/espn.js` – ESPN API calls and data shaping
- `js/sheet.js` – reads the cross-league schedule from the Google Sheet
- `js/season.js` – league and cross-league data shared by the site and the Power Rankings script
- `js/app.js` – pages: placeholders, Standings, Rosters, Matchups, Cross-League
- `assets/img/` – web-sized copies of the logos in `Media/`

## Run locally
```
python -m http.server 8080
```
Then open http://localhost:8080. (Opening `index.html` directly also works in most browsers.)

## Publish
The site is live at https://mgdxfantasy.com on GitHub Pages, deployed from the `main` branch, root folder. Anything pushed to `main` goes live within a few minutes. The domain is registered at Porkbun, and the `CNAME` file holds it for GitHub, so leave that file in place.

`Media/` and `.claude/` are left out by `.gitignore`; the site only uses `assets/`. The weekly schedule also commits to `main`, so pull before making changes.

## New season
Change `SEASON` in `js/config.js` (and the league IDs if ESPN gives you new ones). After editing CSS/JS, bump the `?v=` numbers in `index.html` so visitors get the new files.

## Cross-League
- Pairings come live from the Google Sheet (must stay shared as "anyone with the link can view"). Scores, projections, lineups and results come from ESPN, not the sheet's score columns.
- Each week tab's gid is listed in `CROSS_LEAGUE.weekGids` in `js/config.js`; add one there if you add a tab.
- Teams are matched by owner first name as the site shows it (shortened names like "Jen" work). A typo in a section's league name is tolerated; an owner name the site can't match shows "Not found in ESPN".
- Card records are overall: in-league (ESPN) + cross-league results from completed weeks.

## Standings
- The Standings tabs, Home standings, Power Rankings, and the records, rank badges and season-schedule pairings on Rosters, Matchups and Cross-League read `data/standings.json`, saved by `tools/run-standings.js`. Live scores, projections and lineups still come from ESPN, and each Cross-League week's pairings still come from the sheet.
- If you edit future cross-league pairings in the sheet, rerun the script so the Rosters season schedule shows them.
- `tools/run-standings.js` is safe to rerun. Run it by hand with `node tools/run-standings.js`, or let the GitHub schedule do it once the site is on GitHub. It only rewrites the file when something changed.
- Each page makes one small ESPN request (about 1 KB) to check the current week. If the file is behind ESPN, the page uses live data instead, so a missed run makes it slower, not wrong.
- Owner names and logos in the file are as of the last run, so rerun the script after changing a name in `js/config.js` or a champion in the same file.

## Power Rankings
- Calculated once per week, not in visitors' browsers. `tools/run-power-rankings.js` (Node 18+) saves results to `data/power-rankings.json`, and the site only reads that file. Run it by hand with `node tools/run-power-rankings.js`; add `--force` to recalculate the current week.
- Once the site is on GitHub, `.github/workflows/power-rankings.yml` runs it on a schedule. The script does nothing until ESPN has moved to a new week and finalized the last one, then locks that week's results.
- `tools/projections.js` plays out the rest of the season 10,000 times. A team's expected weekly score is 65% roster projection (best legal lineup from ESPN's rest-of-season player averages, skipping NFL byes and expected missed games) and 35% its actual average so far. Weekly randomness is measured from this season's scores.
- It uses the real remaining in-league and cross-league games, the standings rules (overall win %, then PF), and the playoff format: top 5 make it, top 2 skip round 1 (week 15), seeds 3–5 play a 3-way with the top score advancing, and round 2 (week 16) is a 3-way for the title.
- The settings (`ROSTER_WEIGHT`, `SKILL_SD`, `SIMS`) are at the top of that file. The odds are estimates; the model hasn't been tested against past seasons.

## Transactions
- The tab reads `data/transactions.json`, saved by `node tools/run-transactions.js`, and adds anything newer from ESPN with one small request. Without the file it pulls the whole season live.
- ESPN doesn't publish which players moved in a trade. The script rebuilds trades from rosters around the approval time, so a brand-new trade shows its teams on the site but its players only after the next run. Rebuilt players are a best match, not ESPN's record, and two trades close together between the same teams can't always be separated.

## Draft Boards
- `tools/build-draft-boards.js` saves `data/draft-boards.json` from ESPN's draft results. Column order and corrections from the physical boards are listed at the top of that script. Rerun it once after each draft, after updating those lists.
- The tab makes no live ESPN or Google Sheet requests. Owner names, team logos and player NFL teams are saved in the file as of when it was built, so after changing a name in `js/config.js`, rerun the script and bump the `?v=` on `draft-boards.json` in `js/app.js`. Headshots and logo images still load from ESPN's image servers.

## Notes
- All four leagues are public on ESPN, so no `espn_s2`/SWID cookies are needed. If a league is made private, the browser can no longer read it and the site would need a small server to hold those cookies.
- Win probability is an estimate from live projections (normal model), not ESPN's own number.
- Matchup of the Week is picked automatically: the closest win probability for live/upcoming weeks, the smallest margin for completed weeks.
