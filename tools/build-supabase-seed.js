#!/usr/bin/env node
// Writes supabase/seed-<season>.sql: this season's managers and teams, from data/standings.json.
//   node tools/build-supabase-seed.js
// Paste the file into the Supabase SQL editor after schema.sql. Its last line makes claim codes for any
// manager without one and lists every code. Run it again each new season, once standings.json has the new
// teams: returning managers keep their accounts, and managers who didn't return lose access to members-only
// features.
//
// A manager is matched across seasons by name (the site's owner name, with the config's name changes),
// so a returning manager needs the same name as before.
const fs = require('fs');
const path = require('path');

const MODERATORS = ['Bryce', 'Kat', 'Laith'];

const root = path.join(__dirname, '..');
const standings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'standings.json'), 'utf8'));
const season = standings.season;
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const rows = [];
for (const [league, l] of Object.entries(standings.leagues)) {
  for (const t of l.teams) rows.push({ league, teamId: t.id, teamName: t.name, name: t.owner, id: slug(t.owner) });
}
const ids = rows.map((r) => r.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dupes.length) throw new Error(`Two managers share a name: ${dupes.join(', ')}. Give one a different name in js/config.js.`);
for (const m of MODERATORS) if (!ids.includes(slug(m))) throw new Error(`Moderator ${m} isn't a ${season} manager`);
rows.sort((a, b) => a.league.localeCompare(b.league) || a.name.localeCompare(b.name));

const sql = `-- ${season} managers and teams for the MGDX site accounts. Made by tools/build-supabase-seed.js; run after schema.sql.
begin;

insert into public.managers (id, name) values
${rows.map((r) => `  (${q(r.id)}, ${q(r.name)})`).join(',\n')}
on conflict (id) do update set name = excluded.name;

-- Moderators can hide or remove posts once the blog has them.
update public.managers set is_moderator = (id in (${MODERATORS.map((m) => q(slug(m))).join(', ')}));

delete from public.season_teams where season = ${season};
insert into public.season_teams (season, league, team_id, team_name, manager_id) values
${rows.map((r) => `  (${season}, ${q(r.league)}, ${r.teamId}, ${q(r.teamName)}, ${q(r.id)})`).join(',\n')};

commit;

-- Claim codes: makes any that are missing and lists them all. Send each manager their own code.
select * from public.new_claim_codes();
`;
const out = path.join(root, 'supabase', `seed-${season}.sql`);
fs.writeFileSync(out, sql);
console.log(`Saved ${path.relative(root, out)}: ${rows.length} managers in ${Object.keys(standings.leagues).length} leagues, moderators ${MODERATORS.join(', ')}.`);
