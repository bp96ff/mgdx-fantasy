# Adds one past season to data/history.json for the Archives' League History tab, from that season's
# cross-league Google Sheet exported as .xlsx (File > Download > Microsoft Excel). Needs openpyxl.
#   python tools/build-history.py 2023 sheet.xlsx espn-league-1.json espn-league-2.json ...
# It also saves that season's cross-league games and playoff bracket for its own season page
# (data/seasons/<year>/cross.json and playoffs.json; tools/build-season.js saves the rest).
# Each ESPN file is that season's league from
#   https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/<year>/segments/0/leagues/<id>?view=mTeam&view=mSettings&view=mMatchupScore
# Regular-season records, points and seeds come from the sheet's Standings tab, which is what the league used
# for seeding that year. Cross-league records count the weekly tabs' cross-league and bye-week (median) games;
# the in-league record is what's left of the overall record. Final places come from the sheet's playoff tabs,
# not ESPN's own bracket. Points against add up opponents' scores: in-league games from ESPN, cross-league games
# from the weekly tabs, and the median for bye-week games, the same way the current season counts them.
import json, re, sys
from pathlib import Path
import openpyxl

LEAGUES = {'Lab Rats': 'lab-rats', 'Molecular Mice': 'molecular-mice', 'Genomic Gerbils': 'genomic-gerbils',
           'Research Rodents': 'research-rodents'}

# 2024's sheet already uses each owner's league name, and its Standings tab gives the in-league and
# cross-league split itself; the weekly tabs supply cross-league points against.
# Per season: owners no longer in the league (shown with their league's logo), spellings the sheet uses
# for someone in more than one way, and ESPN first names that aren't the name the league uses ('espn', plus
# 'espn_by_league' for an account that plays as different people in different leagues).
# 'layout' is the sheet's shape: 2023 had two leagues with bye weeks against the median and two-team finals;
# 2024 had four leagues, no byes, and four-team finals (one team from each league).
SEASONS = {
    2023: {
        'layout': 2023,
        'former': ['Anna', 'David', 'Jonathan', 'Kira', 'Patrick', 'Andrew', 'Dominique', 'Chandler'],
        'aliases': {'Dom': 'Dominique', 'Courtney': 'Kayla', 'Sebastian': 'Darbie'},
    },
    2024: {
        'layout': 2024,
        # Jennifer (Genomic Gerbils) isn't the current season's Jen; Tiffany is the current season's Tiffany.
        'former': ['Chandler', 'RJ', 'Andrew', 'Patrick', 'Jonathan', 'Jennifer', 'Magaly', 'David', 'Kyle'],
        'aliases': {},
        'espn': {'James': 'Trace', 'S': 'Sloan', 'Ramon': 'RJ', 'Sebastian': 'Darbie'},
        'espn_by_league': {'molecular-mice': {'Courtney': 'Kayla'}},
    },
    # 2025's sheet has wrong scores and standings (an offseason script error), but its pairings, bye games and
    # playoff matchups are right. So only those come from the sheet; every score and record comes from ESPN.
    2025: {
        'layout': 2025,
        'former': ['Sydney', 'Tom', 'Jennifer', 'Andy', 'Magaly', 'Jonathan'],
        'aliases': {'Sidney P': 'Sidney', 'Sydney B': 'Sydney'},
        # ESPN teams whose owner isn't their account's first name (shared or co-managed accounts), by league and teamId.
        'teams': {
            'lab-rats': {2: 'Trace'},
            'molecular-mice': {1: 'Kat', 3: 'RJ', 4: 'Sloan', 7: 'Kayla', 10: 'Courtney'},
            'genomic-gerbils': {1: 'Laith', 5: 'Tom'},
            'research-rodents': {1: 'Emma', 5: 'Dago'},
        },
    },
}


def rows(ws):
    return [[c for c in r if c is not None] for r in ws.iter_rows(values_only=True) if any(c is not None for c in r)]


def standings(wb, alias):
    """The Standings tab: the leagues side by side, one block of columns each."""
    grid = [list(r) for r in wb['Standings'].iter_rows(values_only=True)]
    names_row = next(r for r in grid if any(c in LEAGUES for c in r))
    teams = []
    for col, name in enumerate(names_row):
        if name not in LEAGUES:
            continue
        for r in grid:
            place = r[col] if col < len(r) else None
            if not isinstance(place, (int, float)):
                continue
            team, owner, w, l, _pct, pts = r[col + 1:col + 7]
            teams.append({
                'owner': alias.get(owner, owner), 'team': re.sub(r'^[xyze] - ', '', team).strip(),
                'league': LEAGUES[name], 'seed': int(place), 'w': int(w), 'l': int(l), 'pf': round(pts, 2),
            })
    return teams


def cross_records(wb, alias):
    """Wins and losses from each "Week N" tab: cross-league games, then bye-week games against the median."""
    rec = {}  # owner: [wins, losses, points against]
    for ws in wb.worksheets:
        if not re.fullmatch(r'Week \d+', ws.title):
            continue
        counting = False
        for v in rows(ws):
            if v[0] in ('Cross-League Matchups', 'BYE Weeks'):
                counting = True
                continue
            if v[0] == 'League Averages':
                counting = False
            if not counting or v[0] not in ('W', 'L'):
                continue
            pts = [x for x in v if isinstance(x, (int, float))]
            for owner, res, opp_pts in ((v[2], v[0], pts[1]), (v[-3], v[-1], pts[0])):
                r = rec.setdefault(alias.get(owner, owner), [0, 0, 0.0])
                r[0 if res == 'W' else 1] += 1
                r[2] += opp_pts
    return rec


def cross_weeks(wb, alias):
    """Every week's cross-league pairings with the sheet's scores and results, in the shape js/sheet.js reads."""
    weeks = {}
    for ws in wb.worksheets:
        m = re.fullmatch(r'Week (\d+)', ws.title)
        if not m:
            continue
        sections, cur = [], None
        for v in rows(ws):
            if v[0] == 'Cross-League Matchups':
                cur = {'leagues': ['Lab Rats', 'Molecular Mice'], 'games': [], 'scores': [], 'results': []}
                sections.append(cur)
            elif v[0] == 'BYE Weeks':
                cur = {'bye': True, 'median': True, 'games': [], 'scores': [], 'results': []}
                sections.append(cur)
            elif v[0] == 'League Averages':
                cur = None
            elif cur is not None and v[0] in ('W', 'L'):
                pts = [x for x in v if isinstance(x, (int, float))]
                a, b = alias.get(v[2], v[2]), alias.get(v[-3], v[-3])
                if cur.get('median'):  # each team on bye played the week's median on its own
                    for owner, res in ((a, v[0]), (b, v[-1])):
                        cur['games'].append([owner, 'Median'])
                        cur['scores'].append([None, pts[0]])
                        cur['results'].append([res, None])
                else:
                    cur['games'].append([a, b])
                    cur['scores'].append(pts[:2])
                    cur['results'].append([v[0], v[-1]])
        weeks[m.group(1)] = sections
    return weeks


def playoff_games(wb, alias, by_owner):
    """The league's own bracket: weeks 15 and 16 per league, then the placement finals in week 17."""
    games = []

    def side(r, c):
        owner = alias.get(r[c], r[c])
        assert owner in by_owner, f'playoff owner {owner}'
        return owner

    def add(week, title, owners, scores):
        lg = next((s for n, s in LEAGUES.items() if title.startswith(n)), None)
        kind = re.sub(r'^(Lab Rats|Molecular Mice|Microgen) ', '', title)
        toilet = any(k in kind for k in ('Losers', 'Ultimate Loser', '6th', '11th', '13th', '15th', 'Toilet'))
        games.append({'week': week, 'title': kind, 'league': lg, 'bracket': 'toilet' if toilet else 'playoffs',
                      'teams': [{'owner': o, 'seed': by_owner[o]['seed'], 'score': round(s, 2)} for o, s in zip(owners, scores)]})

    for name, week in (('Round 1', 15), ('Round 2', 16), ('Other Finals', 17)):
        grid = [list(r) for r in wb[name].iter_rows(values_only=True)]
        for i, r in enumerate(grid):
            for c in (0, 12):
                title = r[c] if c < len(r) else None
                if not isinstance(title, str) or title.startswith('*') or title == 'Seed' or i + 1 >= len(grid):
                    continue
                if grid[i + 1][c] != 'Seed':
                    continue
                j = i + 2
                while j < len(grid) and isinstance(grid[j][c], (int, float)):
                    g = grid[j]
                    add(week, title, [side(g, c + 2), side(g, c + 8)], [g[c + 4], g[c + 6]])
                    j += 1
    for tab, title in (('Championship', 'Championship'), ('Toilet Bowl', 'Toilet Bowl')):
        rs = rows(wb[tab])
        owners = rs[2]
        total = next(x for x in rs if x[0] == 'Total')
        add(17, title, [alias.get(owners[1], owners[1]), alias.get(owners[3], owners[3])], [total[2], total[3]])
    return games


def league_pa(paths, alias, by_owner, by_league=None):
    """Points against in regular-season in-league games, from ESPN's league files. A team with co-owners
    (the commissioner sometimes co-managed) goes to whichever of them the sheet lists in that league."""
    pa = {}
    for path in paths:
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        slug = next(s for n, s in LEAGUES.items() if d['settings']['name'].startswith(n))
        first = {m['id']: (lambda n: n[:1].upper() + n[1:])(m['firstName'].strip()) for m in d['members']}
        here = {**alias, **(by_league or {}).get(slug, {})}
        owner = {}
        for t in d['teams']:
            names = [here.get(first[o], first[o]) for o in t['owners']]
            match = [n for n in names if n in by_owner and by_owner[n]['league'] == slug]
            assert len(match) == 1, f'{t["name"]}: owners {names} vs the sheet'
            owner[t['id']] = match[0]
        for m in d['schedule']:
            if m.get('playoffTierType') != 'NONE' or 'away' not in m:
                continue
            for me, opp in ((m['home'], m['away']), (m['away'], m['home'])):
                pa[owner[me['teamId']]] = pa.get(owner[me['teamId']], 0) + opp['totalPoints']
    return pa


def finals(wb, alias):
    """Every placement game: (place the winner gets, game label, [owner, score], [owner, score])."""
    games = []
    for ws in wb.worksheets:
        rs = rows(ws)
        for i, r in enumerate(rs):
            title = str(r[0]) if r else ''
            m = re.fullmatch(r'Microgen (\d+)(?:st|nd|rd|th) Place Final', title)
            v = rs[i + 2] if i + 2 < len(rs) else []
            if m and len(r) == 1 and v and isinstance(v[0], (int, float)):  # a seeded game, not a scratch tab
                games.append((int(m.group(1)), title.replace('Microgen ', ''),
                              [alias.get(v[2], v[2]), v[4]], [alias.get(v[-3], v[-3]), v[-5]]))
            # Championship and Toilet Bowl tabs list lineups: owners two rows down, scores on the Total row
            m = re.fullmatch(r'(\d{4}) Microgen Fantasy Football (Championship|Toilet Bowl)', title)
            if m and ws.title in ('Championship', 'Toilet Bowl'):
                owners = rs[i + 2]
                total = next(x for x in rs[i:] if x[0] == 'Total')
                games.append((1 if m.group(2) == 'Championship' else None, m.group(2),
                              [alias.get(owners[1], owners[1]), total[2]], [alias.get(owners[3], owners[3]), total[3]]))
    return games


# ---------- the 2024 sheet ----------
def owner_name(cell):
    """'x - Trace', 'e - Laith*' -> 'Trace', 'Laith' (a clinch mark in front, * for the commissioner)."""
    return re.sub(r'^[xyze] - ', '', str(cell)).rstrip('*').strip()


def standings_2024(wb, espn, cfg):
    """The Standings tab: four blocks (two across, two down) of Place, Owner, In-W, In-L, Out-W, Out-L, Tot-W,
    Tot-L, Win %, Points. Team names aren't on the sheet, so they come from ESPN."""
    grid = [list(r) for r in wb['Standings'].iter_rows(values_only=True)]
    teams = []
    for i, r in enumerate(grid):
        for col, name in enumerate(r):
            if name not in LEAGUES:
                continue
            for row in grid[i + 1:]:
                place = row[col] if col < len(row) else None
                if isinstance(place, str) and place in LEAGUES:
                    break
                if not isinstance(place, (int, float)):
                    if any(isinstance(row[c], (int, float)) for c in range(col, min(col + 10, len(row)))):
                        break
                    continue
                owner, in_w, in_l, x_w, x_l, w, l, _pct, pts = row[col + 1:col + 10]
                teams.append({'owner': owner_name(owner), 'league': LEAGUES[name], 'seed': int(place),
                              'w': int(w), 'l': int(l), 'inW': int(in_w), 'inL': int(in_l), 'xW': int(x_w), 'xL': int(x_l),
                              'pf': round(pts, 2)})
    names = espn_team_names(espn, cfg, {(t['league'], t['owner']) for t in teams})
    for t in teams:
        t['team'] = names[(t['league'], t['owner'])]
    return teams


def espn_team_names(paths, cfg, owners):
    """(league, owner) -> the team's ESPN name, naming owners the way league_pa does. owners: (league, owner) pairs."""
    out = {}
    for path in paths:
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        slug = next(s for n, s in LEAGUES.items() if d['settings']['name'].startswith(n))
        here = {**cfg.get('espn', {}), **cfg.get('espn_by_league', {}).get(slug, {})}
        first = {m['id']: (lambda n: n[:1].upper() + n[1:])(m['firstName'].strip()) for m in d['members']}
        for t in d['teams']:
            names = [here.get(first[o], first[o]) for o in t['owners']]
            match = [n for n in names if (slug, n) in owners]
            out[(slug, match[0] if len(match) == 1 else None)] = (t.get('name') or '').strip()
    return out


def cross_weeks_2024(wb, alias):
    """Each "Week N" tab: two sections, each headed by the two leagues playing that week.
    Rows: Result, Team, Current, Final, vs, Final, Current, Team, Result."""
    weeks = {}
    for ws in wb.worksheets:
        m = re.fullmatch(r'Week (\d+)', ws.title)
        if not m:
            continue
        sections, cur = [], None
        for r in ws.iter_rows(values_only=True):
            r = list(r) + [None] * 9
            if r[0] in LEAGUES and r[5] in LEAGUES:
                cur = {'leagues': [r[0], r[5]], 'games': [], 'scores': [], 'results': []}
                sections.append(cur)
            elif cur is not None and r[0] in ('W', 'L') and r[8] in ('W', 'L'):  # the middle cell is 'vs' or a tag like 'Top 10'
                cur['games'].append([alias.get(r[1], r[1]), alias.get(r[7], r[7])])
                cur['scores'].append([round(r[3], 2), round(r[5], 2)])
                cur['results'].append([r[0], r[8]])
            elif r[3] == 'Weekly Averages':
                cur = None
        weeks[m.group(1)] = sections
    return weeks


def cross_records_2024(weeks):
    rec = {}  # owner: [wins, losses, points against]
    for sections in weeks.values():
        for s in sections:
            for (a, b), (sa, sb), (ra, rb) in zip(s['games'], s['scores'], s['results']):
                for owner, res, opp in ((a, ra, sb), (b, rb, sa)):
                    r = rec.setdefault(owner, [0, 0, 0.0])
                    r[0 if res == 'W' else 1] += 1
                    r[2] += opp
    return rec


def playoff_games_2024(wb, alias, by_owner):
    """Weeks 15 and 16 in each league (Champions and Toilet Bowl tabs), then week 17's four-team finals between
    the leagues: the Champions Cup, the Toilet Bowl Final and the placement finals in "Other Matchups"."""
    games = []

    def team(owner, score):
        owner = alias.get(owner, owner)
        assert owner in by_owner, f'playoff owner {owner}'
        return {'owner': owner, 'seed': by_owner[owner]['seed'], 'score': round(score, 2)}

    def title_of(text):
        t = re.sub(r'^(' + '|'.join(LEAGUES) + r') ', '', text.strip())
        return re.sub(r' Match$', '', t)

    for tab, week, bracket in (('Champions R1', 15, 'playoffs'), ('Toilet Bowl R1', 15, 'toilet'),
                               ('Champions R2', 16, 'playoffs'), ('Toilet Bowl R2', 16, 'toilet')):
        grid = [list(r) for r in wb[tab].iter_rows(values_only=True)]
        for i, r in enumerate(grid[:-1]):
            for c, text in enumerate(r):
                if not isinstance(text, str) or not any(text.startswith(n) for n in LEAGUES) or grid[i + 1][c] != 'Seed':
                    continue
                head = grid[i + 1]
                # This game's columns run from its Seed to the next Seed: Team ... Total ... Total ... Team.
                end = next((k for k in range(c + 1, len(head)) if head[k] == 'Seed'), len(head))
                cols = range(c, end + 1)
                team_cols = [k for k in cols if head[k] == 'Team']
                total_cols = [k for k in cols if head[k] == 'Total']
                lg = next(s for n, s in LEAGUES.items() if text.startswith(n))
                j = i + 2
                while j < len(grid) and isinstance(grid[j][c], (int, float)):
                    g = grid[j]
                    games.append({'week': week, 'title': title_of(text), 'league': lg, 'bracket': bracket,
                                  'teams': [team(g[team_cols[0]], g[total_cols[0]]), team(g[team_cols[1]], g[total_cols[1]])]})
                    j += 1
    # The two big finals: owners on row 3, scores on the Total row (each team's Score column).
    for tab, title, name, bracket in (('Champions Cup', 'Championship', 'Champions Cup', 'playoffs'),
                                      ('Toilet Bowl Final', 'Toilet Bowl', 'Toilet Bowl Final', 'toilet')):
        grid = [list(r) for r in wb[tab].iter_rows(values_only=True)]
        owners = grid[2]
        total = next(r for r in grid if r[0] == 'Total')
        games.append({'week': 17, 'title': title, 'name': name, 'league': None, 'bracket': bracket,
                      'teams': [team(owners[c + 2], total[c + 3]) for c in (0, 4, 8, 12)]})
    grid = [list(r) for r in wb['Other Matchups'].iter_rows(values_only=True)]
    for i, r in enumerate(grid):
        m = re.fullmatch(r'Microgen (\d+)(?:st|nd|rd|th) Place Final', str(r[0] or ''))
        if not m:
            continue
        rows_ = grid[i + 2:i + 4]
        place = int(m.group(1))
        games.append({'week': 17, 'title': f'{ordinal(place)} Place Final', 'league': None,
                      'bracket': 'toilet' if place >= 17 else 'playoffs',
                      'teams': [t for g in rows_ for t in (team(g[1], g[3]), team(g[7], g[5]))]})
    return games


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def place_finals(games, teams):
    """Week 17's four-team finals give out four places each: the Champions Cup 1st to 4th by score, a placement
    final from its number down, and the Toilet Bowl Final the last four, the lowest score last."""
    size = len(teams)
    for g in games:
        if g['week'] != 17:
            continue
        base = 1 if g['title'] == 'Championship' else size - 3 if g['title'] == 'Toilet Bowl' else int(re.match(r'\d+', g['title']).group())
        ranked = sorted(g['teams'], key=lambda x: -x['score'])
        label = g.get('name', g['title'])
        for k, side in enumerate(ranked):
            t = next(t for t in teams if t['owner'] == side['owner'])
            assert 'finish' not in t, f'{side["owner"]} placed twice'
            t['finish'] = base + k
            # The team just ahead (or, for the top score, just behind), for the award notes.
            near = ranked[1] if k == 0 else ranked[k - 1]
            t['final'] = {'label': label, 'won': k == 0, 'score': side['score'], 'opp': near['owner'],
                          'oppScore': near['score'], 'place': k + 1, 'of': len(ranked)}


def build_2024(season, path, espn):
    cfg = SEASONS[season]
    wb = openpyxl.load_workbook(path, data_only=True)
    teams = standings_2024(wb, espn, cfg)
    by_owner = {t['owner']: t for t in teams}
    assert len(by_owner) == len(teams), 'owner names must be unique'
    weeks = cross_weeks_2024(wb, cfg['aliases'])
    cross = cross_records_2024(weeks)
    assert set(cross) == set(by_owner), f'cross-league owners differ: {sorted(set(cross) ^ set(by_owner))}'
    for owner, (xw, xl, _) in cross.items():
        t = by_owner[owner]
        if (xw, xl) != (t['xW'], t['xL']):
            print(f"note: {owner}'s weekly tabs add up to {xw}-{xl} cross-league; Standings says {t['xW']}-{t['xL']}")
    in_pa = league_pa(espn, cfg.get('espn', {}), by_owner, cfg.get('espn_by_league'))
    assert set(in_pa) == set(by_owner), f'ESPN and sheet owners differ: {sorted(set(in_pa) ^ set(by_owner))}'
    for owner, (_, _, xpa) in cross.items():
        t = by_owner[owner]
        t.update({'pa': round(in_pa[owner] + xpa, 2), 'crossPa': round(xpa, 2)})
    games = playoff_games_2024(wb, cfg['aliases'], by_owner)
    place_finals(games, teams)
    assert sorted(t['finish'] for t in teams) == list(range(1, len(teams) + 1)), 'every place filled once'
    for t in teams:
        t['former'] = t['owner'] in cfg['former']
    teams.sort(key=lambda t: t['finish'])
    site = Path(__file__).resolve().parent.parent / 'data' / 'seasons' / str(season)
    site.mkdir(parents=True, exist_ok=True)
    for name, data in (('cross', {'weeks': weeks}), ('playoffs', {'games': games})):
        (site / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')
    leagues = sorted({t['league'] for t in teams}, key=list(LEAGUES.values()).index)
    return {
        'leagues': leagues,
        'grandChampion': teams[0]['owner'],
        'ultimateLoser': teams[-1]['owner'],
        'champions': {lg: next(t['owner'] for t in teams if t['league'] == lg) for lg in leagues},
        'teams': teams,
    }


# ---------- 2025: pairings from the sheet, everything else from ESPN ----------
def espn_2025(paths, cfg):
    """Each team's owner, ESPN team, weekly scores (weeks 1-17) and in-league games, from ESPN's league files."""
    teams, games = {}, []
    for path in paths:
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        slug = next(s for n, s in LEAGUES.items() if d['settings']['name'].startswith(n))
        first = {m['id']: (lambda n: n[:1].upper() + n[1:])(m['firstName'].strip()) for m in d['members']}
        named = cfg['teams'].get(slug, {})
        owner_of = {}
        for t in d['teams']:
            owner = named.get(t['id']) or first[t['primaryOwner']]
            assert owner not in teams, f'two teams for {owner}'
            owner_of[t['id']] = owner
            teams[owner] = {'owner': owner, 'league': slug, 'team': (t.get('name') or '').strip(), 'scores': {}}
        for m in d['schedule']:
            week = m['matchupPeriodId']
            for side in ('home', 'away'):
                if side in m:
                    teams[owner_of[m[side]['teamId']]]['scores'][week] = round(m[side]['totalPoints'], 2)
            if week <= 14 and 'away' in m:
                games.append((week, owner_of[m['home']['teamId']], owner_of[m['away']['teamId']]))
    for t in teams.values():
        assert sorted(t['scores']) == list(range(1, 18)), f"{t['owner']} is missing a week"
    return teams, games


def cross_pairs_2025(wb, alias):
    """Each "Week N" tab: two sections (a row naming the two leagues, then Result/Team/... headings, then the games),
    then "Bye Weeks", where the teams on bye in their own league play each other. Only the pairings are read: the
    league names are sometimes blank and the middle cell is "vs" or a tag like "Top 10", so a section starts at its
    heading row and its leagues come from its teams."""
    weeks = {}
    for ws in wb.worksheets:
        m = re.fullmatch(r'Week (\d+)', ws.title)
        if not m:
            continue
        sections, cur = [], None
        for r in ws.iter_rows(values_only=True):
            r = list(r) + [None] * 11
            if r[0] == 'Bye Weeks':
                cur = {'bye': True, 'games': []}
                sections.append(cur)
            elif r[1] == 'Team' and r[9] == 'Team':
                cur = {'games': []}
                sections.append(cur)
            elif cur is not None and isinstance(r[1], str) and isinstance(r[9], str) and r[1].strip() and r[9].strip():
                cur['games'].append([alias.get(r[1].strip(), r[1].strip()), alias.get(r[9].strip(), r[9].strip())])
        weeks[int(m.group(1))] = sections
    return weeks


def playoff_games_2025(wb, alias, teams):
    """Round 1 (week 15): each league's three-team Wildcard (seeds 3-5) and two Losers games (seeds 6-9).
    Round 2 (week 16): the three-team league Championship, the 4th Place game, the Losers Final and the 6th Place
    game. Week 17: four-team finals between the leagues. Pairings and seeds from the sheet; scores from ESPN."""
    games, seeds = [], {}

    def team(name, week):
        owner = alias.get(name, name)
        assert owner in teams, f'playoff owner {owner}'
        return {'owner': owner, 'seed': None, 'score': teams[owner]['scores'][week]}

    def title_of(text):
        t = re.sub(r'^(' + '|'.join(LEAGUES) + r') ', '', text.strip())
        return {'Losers R1': 'Losers Round 1', '4th Place Match': '4th Place', '6th Place Match': '6th Place'}.get(t, t)

    for tab, week, bracket in (('R1 Wildcard', 15, 'playoffs'), ('Toilet Bowl R1', 15, 'toilet'),
                               ('R2 League Finals', 16, None), ('Toilet Bowl R2', 16, 'toilet')):
        grid = [list(r) + [None] * 11 for r in wb[tab].iter_rows(values_only=True)]
        for i, r in enumerate(grid[:-1]):
            for c in (0, 6):
                text = r[c]
                if not isinstance(text, str) or not any(text.startswith(n) for n in LEAGUES) or grid[i + 1][c] != 'Seed':
                    continue
                lg = next(s for n, s in LEAGUES.items() if text.startswith(n))
                side = []
                j = i + 2
                while j < len(grid) and isinstance(grid[j][c], (int, float)):
                    t = team(grid[j][c + 1], week)
                    t['seed'] = int(grid[j][c])
                    seeds[t['owner']] = t['seed']
                    side.append(t)
                    j += 1
                title = title_of(text)
                games.append({'week': week, 'title': title, 'league': lg, 'teams': side,
                              'bracket': bracket or ('playoffs' if title in ('Championship', '4th Place') else 'toilet')})
    for tab, title, name, bracket in (('The Champions Cup', 'Championship', 'Champions Cup', 'playoffs'),
                                      ('Toilet Bowl Finals', 'Toilet Bowl', 'Toilet Bowl Final', 'toilet')):
        owners = [list(r) for r in wb[tab].iter_rows(values_only=True)][2]
        games.append({'week': 17, 'title': title, 'name': name, 'league': None, 'bracket': bracket,
                      'teams': [team(owners[c + 2], 17) for c in (0, 4, 8, 12)]})
    grid = [list(r) + [None] * 9 for r in wb['Other Matchups'].iter_rows(values_only=True)]
    for i, r in enumerate(grid):
        m = re.fullmatch(r'Microgen (\d+)(?:st|nd|rd|th) Place Final', str(r[0] or ''))
        if m:
            place = int(m.group(1))
            games.append({'week': 17, 'title': f'{ordinal(place)} Place Final', 'league': None,
                          'bracket': 'toilet' if place > 20 else 'playoffs',  # 20 playoff teams: 5 per league
                          'teams': [team(g[c], 17) for g in grid[i + 2:i + 4] for c in (0, 8)]})
    for g in games:
        for t in g['teams']:
            t['seed'] = seeds[t['owner']]
    return games, seeds


def build_2025(season, path, espn):
    cfg = SEASONS[season]
    wb = openpyxl.load_workbook(path, data_only=True)
    espn_teams, league_games = espn_2025(espn, cfg)
    score = lambda owner, week: espn_teams[owner]['scores'][week]
    rec = {o: {'w': 0, 'l': 0, 't': 0, 'inW': 0, 'inL': 0, 'inT': 0, 'xW': 0, 'xL': 0, 'xT': 0, 'pa': 0.0, 'crossPa': 0.0, 'byePf': 0.0}
           for o in espn_teams}

    def play(a, b, week, cross):
        sa, sb = score(a, week), score(b, week)
        assert not (cross and sa == sb), f'week {week}: cross-league tie, {a} and {b}'
        for me, opp, mine, theirs in ((a, b, sa, sb), (b, a, sb, sa)):
            r = rec[me]
            res = 'W' if mine > theirs else 'L' if mine < theirs else 'T'  # ESPN had two in-league ties in 2025
            r[res.lower()] += 1
            r[('x' if cross else 'in') + res] += 1
            r['pa'] += theirs
            if cross:
                r['crossPa'] += theirs

    for week, a, b in league_games:
        play(a, b, week, False)
    pairs = cross_pairs_2025(wb, cfg['aliases'])
    assert sorted(pairs) == list(range(1, 15)), 'weeks 1-14'
    weeks = {}
    for week, sections in sorted(pairs.items()):
        out = []
        names = {slug: name for name, slug in LEAGUES.items()}
        for sec in sections:
            if not sec.get('bye'):
                pair = {(espn_teams[a]['league'], espn_teams[b]['league']) for a, b in sec['games']}
                assert len(pair) == 1, f'week {week}: a section mixes leagues {pair}'
                sec['leagues'] = [names[x] for x in pair.pop()]
            for a, b in sec['games']:
                assert a in espn_teams and b in espn_teams, f'week {week}: {a} vs {b}'
                play(a, b, week, True)
                if sec.get('bye'):
                    rec[a]['byePf'] += score(a, week)
                    rec[b]['byePf'] += score(b, week)
            scores = [[score(a, week), score(b, week)] for a, b in sec['games']]
            out.append({**({'bye': True} if sec.get('bye') else {'leagues': sec['leagues']}), 'games': sec['games'], 'scores': scores,
                        'results': [['W', 'L'] if x > y else ['L', 'W'] for x, y in scores]})
        played = [o for sec in sections if not sec.get('bye') for g in sec['games'] for o in g]
        assert sorted(played) == sorted(espn_teams), f'week {week}: cross-league games cover {len(played)} of {len(espn_teams)} teams'
        weeks[str(week)] = out
    games, seeds = playoff_games_2025(wb, cfg['aliases'], espn_teams)
    teams = []
    for owner, t in espn_teams.items():
        r = rec[owner]
        assert r['w'] + r['l'] + r['t'] == 28, f"{owner} played {r['w'] + r['l'] + r['t']} games"
        teams.append({'owner': owner, 'team': t['team'], 'league': t['league'], 'seed': seeds[owner],
                      'w': r['w'], 'l': r['l'], 't': r['t'], 'inW': r['inW'], 'inL': r['inL'], 'inT': r['inT'],
                      'xW': r['xW'], 'xL': r['xL'],
                      'pf': round(sum(t['scores'][w] for w in range(1, 15)), 2), 'pa': round(r['pa'], 2), 'crossPa': round(r['crossPa'], 2)})
    # The bracket's seeds should be the league's order by overall record, then points for.
    for lg in LEAGUES.values():
        mine = sorted((t for t in teams if t['league'] == lg), key=lambda t: (-(t['w'] + t['t'] / 2) / 28, -t['pf']))
        for k, t in enumerate(mine):
            if t['seed'] != k + 1:
                print(f"note: {t['owner']} ({lg}) is seed {t['seed']} in the bracket; ESPN's numbers rank them {k + 1}")
    place_finals(games, teams)
    assert sorted(t['finish'] for t in teams) == list(range(1, len(teams) + 1)), 'every place filled once'
    for t in teams:
        t['former'] = t['owner'] in cfg['former']
    teams.sort(key=lambda t: t['finish'])
    site = Path(__file__).resolve().parent.parent / 'data' / 'seasons' / str(season)
    site.mkdir(parents=True, exist_ok=True)
    for name, data in (('cross', {'weeks': weeks}), ('playoffs', {'games': games})):
        (site / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')
    leagues = sorted({t['league'] for t in teams}, key=list(LEAGUES.values()).index)
    return {
        'leagues': leagues,
        'grandChampion': teams[0]['owner'],
        'ultimateLoser': teams[-1]['owner'],
        'champions': {lg: next(t['owner'] for t in teams if t['league'] == lg) for lg in leagues},
        'teams': teams,
    }


def build(season, path, espn):
    if SEASONS[season]['layout'] == 2025:
        return build_2025(season, path, espn)
    if SEASONS[season]['layout'] == 2024:
        return build_2024(season, path, espn)
    return build_2023(season, path, espn)


def build_2023(season, path, espn):
    cfg = SEASONS[season]
    wb = openpyxl.load_workbook(path, data_only=True)
    teams = standings(wb, cfg['aliases'])
    by_owner = {t['owner']: t for t in teams}
    assert len(by_owner) == len(teams), 'owner names must be unique'
    cross = cross_records(wb, cfg['aliases'])
    assert set(cross) == set(by_owner), 'every team has cross-league games'
    in_pa = league_pa(espn, cfg['aliases'], by_owner)
    assert set(in_pa) == set(by_owner), f'ESPN and sheet owners differ: {sorted(set(in_pa) ^ set(by_owner))}'
    for owner, (xw, xl, xpa) in cross.items():
        t = by_owner[owner]
        t.update({'xW': xw, 'xL': xl, 'inW': t['w'] - xw, 'inL': t['l'] - xl,
                  'pa': round(in_pa[owner] + xpa, 2), 'crossPa': round(xpa, 2)})
    for g in finals(wb, cfg['aliases']):
        place, label, a, b = g
        if place is None:  # the Toilet Bowl decides last place
            place = len(teams) - 1
        win, lose = (a, b) if a[1] > b[1] else (b, a)
        for side, p, won in ((win, place, True), (lose, place + 1, False)):
            t = by_owner[side[0]]
            assert 'finish' not in t, f'{side[0]} placed twice'
            t['finish'] = p
            t['final'] = {'label': label, 'won': won, 'score': round(side[1], 2),
                          'opp': lose[0] if won else win[0], 'oppScore': round((lose if won else win)[1], 2)}
    assert sorted(t['finish'] for t in teams) == list(range(1, len(teams) + 1)), 'every place filled once'
    for t in teams:
        t['former'] = t['owner'] in cfg['former']
    teams.sort(key=lambda t: t['finish'])
    site = Path(__file__).resolve().parent.parent / 'data' / 'seasons' / str(season)
    site.mkdir(parents=True, exist_ok=True)
    for name, data in (('cross', {'weeks': cross_weeks(wb, cfg['aliases'])}),
                       ('playoffs', {'games': playoff_games(wb, cfg['aliases'], by_owner)})):
        (site / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False) + '\n', encoding='utf-8')
    leagues = sorted({t['league'] for t in teams}, key=list(LEAGUES.values()).index)
    return {
        'leagues': leagues,
        'medianByes': True,
        'grandChampion': teams[0]['owner'],
        'ultimateLoser': teams[-1]['owner'],
        'champions': {lg: next(t['owner'] for t in teams if t['league'] == lg) for lg in leagues},
        'teams': teams,
    }


if __name__ == '__main__':
    season = int(sys.argv[1])
    out = Path(__file__).resolve().parent.parent / 'data' / 'history.json'
    data = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {'seasons': {}}
    data['seasons'][str(season)] = build(season, sys.argv[2], sys.argv[3:])
    data['seasons'] = dict(sorted(data['seasons'].items()))
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    s = data['seasons'][str(season)]
    print(season, 'grand champion', s['grandChampion'], '| champions', s['champions'], '| ultimate loser', s['ultimateLoser'])
    for t in s['teams']:
        print(f"{t['finish']:>2} {t['owner']:<10} {t['league']:<15} {t['w']}-{t['l']}{'-' + str(t['t']) if t.get('t') else ''} (league {t['inW']}-{t['inL']}, cross {t['xW']}-{t['xL']}) {t['pf']:>8} PA {t['pa']:>8} (cross {t['crossPa']:>7}) {t['final']['label']} {'W' if t['final']['won'] else 'L'}")
