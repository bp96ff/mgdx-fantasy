-- When each 2026 week's Predictions lock: its first NFL game's kickoff (UTC).
-- Made by node tools/build-pick-locks.js. Safe to run again; it updates the times.
insert into public.pick_locks (season, week, locks_at) values
  (2026, 1, '2026-09-10T00:20:00.000Z'),
  (2026, 2, '2026-09-18T00:15:00.000Z'),
  (2026, 3, '2026-09-25T00:15:00.000Z'),
  (2026, 4, '2026-10-02T00:15:00.000Z'),
  (2026, 5, '2026-10-09T00:15:00.000Z'),
  (2026, 6, '2026-10-16T00:15:00.000Z'),
  (2026, 7, '2026-10-23T00:15:00.000Z'),
  (2026, 8, '2026-10-30T00:15:00.000Z'),
  (2026, 9, '2026-11-06T01:15:00.000Z'),
  (2026, 10, '2026-11-13T01:15:00.000Z'),
  (2026, 11, '2026-11-20T01:15:00.000Z'),
  (2026, 12, '2026-11-26T01:00:00.000Z'),
  (2026, 13, '2026-12-04T01:15:00.000Z'),
  (2026, 14, '2026-12-11T01:15:00.000Z')
on conflict (season, week) do update set locks_at = excluded.locks_at;
