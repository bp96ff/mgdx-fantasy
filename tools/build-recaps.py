# Turns the weekly recap Google Doc (exported as plain text) into data/recaps.json for the Blog's Recaps tab.
#   python tools/build-recaps.py recaps.txt
# Each week runs from its opening paragraphs through the "Week N Recap" sections. Sections the site already
# covers elsewhere (high and low scores, shoutouts, blowouts, Top 10, matchups of the week) are left out.
# Markup in the output: *italic* and ~~struck~~, matching the doc's own formatting.
import json, re, sys
from pathlib import Path

KINDS = [  # (pattern for the label before the colon, kind); HM labels are honorable mentions of the same kind
    (r'A New Challenger Approaches', 'challenger'),
    (r'Game of the Week', 'game'),
    (r'Upset of the Week', 'upset'),
    (r'Bad beat of the week', 'badbeat'),
    (r'Lucky team of the (week|year)', 'lucky'),
    (r'Dawg of the week', 'dawg'),
    (r'(\(Not so\) )?Fun facts? of the week', 'funfact'),
]
DROP = [r'High Score of the Week', r'Score Shoutouts', r'Low Score of the Week', r'Biggest Blowout', r'HM Blowout']
DROP_BLOCK = [r'Top 10', r'Week \d+ Matchups of the Week']  # these run on for several lines

# The doc's italics and strikethrough, which a plain-text export loses
STYLE = [
    ('Lucky team of the week year', 'Lucky team of the ~~week~~ year'),
    ('only sub-80 point victory', 'only *sub-80 point* victory'),
    ('since January of 2025', 'since *January of 2025*'),
    ('pace of 521.9 points', 'pace of *521.9* points'),
    ('It appears as though', 'It *appears* as though'),
    ('on track to set the all-time scoring record!', 'on track *to set the all-time scoring record!*'),
    ('Julia takes the W 112.6 – 111.8.', 'Julia takes the W 112.6 – 111.18.'),  # typo in the doc; ESPN has 111.18
    ('weeks with only wins until', 'weeks with *only wins* until'),
    ('straight weeks without a loss before', 'straight weeks *without a loss* before'),
    ('League favorite Sydney dropped', 'League favorite Sidney dropped'),  # spelling in the doc
]

# Final scores for each Game of the Week, winner first, in the order the sections appear
SCORES = {
    (1, 0): [['Sarah', 108.26], ['Ryan', 105.90]],
    (2, 0): [['Sarah', 143.08], ['Craig', 137.18]],
    (3, 0): [['Amanda', 104.54], ['Sloan', 103.18]],
    (3, 1): [['Jen', 115.92], ['Kayla', 113.44]],
    (4, 0): [['Craig', 138.50], ['Jake', 137.58]],
    (4, 1): [['Jen', 156.42], ['Tiffany', 154.00]],
    (5, 0): [['Celina', 141.06], ['Ryan', 140.04]],
    (5, 1): [['Sloan', 137.10], ['Trace', 134.98]],
    (6, 0): [['Amanda', 107.18], ['Courtney', 106.18]],
    (6, 1): [['Julia', 112.60], ['Craig', 111.18]],
    (7, 0): [['Amanda', 102.58], ['Nick', 102.44]],
    (8, 0): [['Darbie', 137.16], ['Celina', 135.02]],
    (9, 0): [['Darcy', 118.38], ['Alan', 115.36]],
}


def clean(s):
    return re.sub(r'\s+', ' ', s.replace(' ', ' ')).strip()


def build(text):
    text = text.replace(' ', ' ')
    for a, b in STYLE:
        assert text.count(a) == 1, a
        text = text.replace(a, b)
    lines = [clean(l) for l in text.lstrip('﻿').splitlines()]
    weeks, intro, cur, sec, skipping, blanks = [], [], None, None, False, 0
    for line in lines:
        blanks = blanks + 1 if not line else 0
        m = re.fullmatch(r'Week (\d+) Recap', line)
        if m:
            # Recaps run in order, so a repeated heading (Week 9's reads "Week 8 Recap" in the doc) is the next week
            n = int(m.group(1)) if not weeks or int(m.group(1)) > weeks[-1]['week'] else weeks[-1]['week'] + 1
            cur = {'week': n, 'intro': intro, 'sections': []}
            weeks.append(cur)
            intro, sec, skipping = [], None, False
            continue
        if not line:
            # Two blank lines in a row end a week; the next paragraphs are the following week's opening
            if blanks == 2:
                sec, skipping = None, False
            continue
        if cur is None or (sec is None and not skipping and not re.match(r'[^:]{3,45}:', line)):
            if not line.startswith('*This is the last recap'):  # a note about the doc itself
                intro.append(line)
            continue
        label, _, rest = line.partition(':')
        hm = label.startswith('HM ')
        base = label[3:] if hm else label
        kind = next((k for p, k in KINDS if re.fullmatch(p, base.replace('~~week~~ ', ''))), None)
        if any(re.fullmatch(p, label) for p in DROP) or any(re.fullmatch(p, label) for p in DROP_BLOCK):
            sec, skipping = None, any(re.fullmatch(p, label) for p in DROP_BLOCK)
            continue
        if kind:
            skipping = False
            entry = {'kind': kind, 'label': label[3:] if hm else label, 'body': []}
            if rest.strip():
                entry['body'].append(rest.strip())
            if hm:
                parent = next((s for s in reversed(cur['sections']) if s['kind'] == kind), None)
                assert parent, line
                parent.setdefault('hm', []).append(entry)
            else:
                cur['sections'].append(entry)
            sec = entry
            continue
        if skipping or sec is None:
            # Lines after the last section belong to the next week's opening paragraphs
            if not skipping:
                intro.append(line)
            elif not re.match(r'(\d+\.|#\d|[A-Z][a-z-]+ vs\.)', line):
                skipping = False
                sec = None
                intro.append(line)
            continue
        if line.startswith('-'):
            body = sec['body']
            if not body or not isinstance(body[-1], list):
                body.append([])
            body[-1].append(line.lstrip('- ').strip())
        else:
            sec['body'].append(line)
    for w in weeks:
        n = 0
        for s in w['sections']:
            for e in [s] + s.get('hm', []):
                if s['kind'] == 'game':
                    e['score'] = SCORES[(w['week'], n)]
                    n += 1
        assert all((w['week'], k) in SCORES for k in range(n))
    return weeks


if __name__ == '__main__':
    src = Path(sys.argv[1]).read_text(encoding='utf-8-sig')
    weeks = build(src)
    out = Path(__file__).resolve().parent.parent / 'data' / 'recaps.json'
    out.write_text(json.dumps({'weeks': weeks}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    for w in weeks:
        print(w['week'], len(w['intro']), 'intro,', [s['kind'] + ('+%d' % len(s.get('hm', [])) if s.get('hm') else '') for s in w['sections']])
