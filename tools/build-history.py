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

# Per season: owners no longer in the league (shown with their league's logo) and spellings the sheet uses
# for someone in more than one way.
SEASONS = {
    2023: {
        'former': ['Anna', 'David', 'Jonathan', 'Kira', 'Patrick', 'Andrew', 'Dominique', 'Chandler'],
        'aliases': {'Dom': 'Dominique', 'Courtney': 'Kayla', 'Sebastian': 'Darbie'},
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


def league_pa(paths, alias, by_owner):
    """Points against in regular-season in-league games, from ESPN's league files. A team with co-owners
    (the commissioner sometimes co-managed) goes to whichever of them the sheet lists in that league."""
    pa = {}
    for path in paths:
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        slug = next(s for n, s in LEAGUES.items() if d['settings']['name'].startswith(n))
        first = {m['id']: (lambda n: n[:1].upper() + n[1:])(m['firstName'].strip()) for m in d['members']}
        owner = {}
        for t in d['teams']:
            names = [alias.get(first[o], first[o]) for o in t['owners']]
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


def build(season, path, espn):
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
        print(f"{t['finish']:>2} {t['owner']:<10} {t['league']:<15} {t['w']}-{t['l']} (league {t['inW']}-{t['inL']}, cross {t['xW']}-{t['xL']}) {t['pf']:>8} PA {t['pa']:>8} (cross {t['crossPa']:>7}) {t['final']['label']} {'W' if t['final']['won'] else 'L'}")
