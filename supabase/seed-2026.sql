-- 2026 managers and teams for the MGDX site accounts. Made by tools/build-supabase-seed.js; run after schema.sql.
begin;

insert into public.managers (id, name) values
  ('alan', 'Alan'),
  ('daniel', 'Daniel'),
  ('darbie', 'Darbie'),
  ('haley', 'Haley'),
  ('jen', 'Jen'),
  ('laith', 'Laith'),
  ('purcella', 'Purcella'),
  ('sloan', 'Sloan'),
  ('tisha', 'Tisha'),
  ('bryce', 'Bryce'),
  ('celina', 'Celina'),
  ('julia', 'Julia'),
  ('karen', 'Karen'),
  ('marsha', 'Marsha'),
  ('nick', 'Nick'),
  ('rocio', 'Rocio'),
  ('ryan', 'Ryan'),
  ('trace', 'Trace'),
  ('amanda', 'Amanda'),
  ('courtney', 'Courtney'),
  ('destiny', 'Destiny'),
  ('jana', 'Jana'),
  ('kat', 'Kat'),
  ('kayla', 'Kayla'),
  ('sarah', 'Sarah'),
  ('sidney', 'Sidney'),
  ('xenia', 'Xenia'),
  ('ciana', 'Ciana'),
  ('craig', 'Craig'),
  ('dago', 'Dago'),
  ('darcy', 'Darcy'),
  ('emma', 'Emma'),
  ('hoai-nha', 'Hoai-Nha'),
  ('jake', 'Jake'),
  ('jenna', 'Jenna'),
  ('tiffany', 'Tiffany')
on conflict (id) do update set name = excluded.name;

-- Moderators can hide or remove posts once the blog has them.
update public.managers set is_moderator = (id in ('bryce', 'kat', 'laith'));

delete from public.season_teams where season = 2026;
insert into public.season_teams (season, league, team_id, team_name, manager_id) values
  (2026, 'genomic-gerbils', 7, 'Hot Chub Time Machine', 'alan'),
  (2026, 'genomic-gerbils', 5, 'Sorsby''s Bad Bet', 'daniel'),
  (2026, 'genomic-gerbils', 3, 'Ur mom', 'darbie'),
  (2026, 'genomic-gerbils', 4, 'I can''t find McConkeys', 'haley'),
  (2026, 'genomic-gerbils', 6, 'Jen''s Team', 'jen'),
  (2026, 'genomic-gerbils', 1, 'The Man in Jahmyrror', 'laith'),
  (2026, 'genomic-gerbils', 2, 'Velvet Venom Sleepers', 'purcella'),
  (2026, 'genomic-gerbils', 9, 'the End of YoRHa', 'sloan'),
  (2026, 'genomic-gerbils', 8, 'TNT', 'tisha'),
  (2026, 'lab-rats', 1, 'Divine Intervention', 'bryce'),
  (2026, 'lab-rats', 7, 'Celina''s Cool Team', 'celina'),
  (2026, 'lab-rats', 5, 'Julia''s Scary Team', 'julia'),
  (2026, 'lab-rats', 11, 'Karen''s Top-Notch Team', 'karen'),
  (2026, 'lab-rats', 12, 'Yaya''s Yahoos', 'marsha'),
  (2026, 'lab-rats', 3, 'Regulatory Red Flags', 'nick'),
  (2026, 'lab-rats', 4, 'Runaway Corgi Pups', 'rocio'),
  (2026, 'lab-rats', 6, 'Running up that Hill', 'ryan'),
  (2026, 'lab-rats', 2, 'I didn''t hear no bell', 'trace'),
  (2026, 'molecular-mice', 9, 'Amanda''s Astounding Team', 'amanda'),
  (2026, 'molecular-mice', 10, 'Da Bear Necessities', 'courtney'),
  (2026, 'molecular-mice', 8, 'Destiny''s Driven Team', 'destiny'),
  (2026, 'molecular-mice', 4, 'Unorthodox Strategy', 'jana'),
  (2026, 'molecular-mice', 1, 'For the Sun God', 'kat'),
  (2026, 'molecular-mice', 7, 'Say CHEESE!', 'kayla'),
  (2026, 'molecular-mice', 2, 'Sarah''s Smart Team', 'sarah'),
  (2026, 'molecular-mice', 3, 'Sidney''s Super Team', 'sidney'),
  (2026, 'molecular-mice', 5, 'Baddies', 'xenia'),
  (2026, 'research-rodents', 2, 'Participation Pointers', 'ciana'),
  (2026, 'research-rodents', 8, 'The Bedlam McBrides', 'craig'),
  (2026, 'research-rodents', 5, 'Taylor Gang', 'dago'),
  (2026, 'research-rodents', 9, 'Dream Reapers', 'darcy'),
  (2026, 'research-rodents', 1, 'Hail Mary Pass', 'emma'),
  (2026, 'research-rodents', 6, 'Hoai-Nha''s Bro Dudes', 'hoai-nha'),
  (2026, 'research-rodents', 3, 'Prestige Worldwide', 'jake'),
  (2026, 'research-rodents', 7, 'Da Geese', 'jenna'),
  (2026, 'research-rodents', 4, 'Tortured Touchdown Department', 'tiffany');

commit;

-- Claim codes: makes any that are missing and lists them all. Send each manager their own code.
select * from public.new_claim_codes();
