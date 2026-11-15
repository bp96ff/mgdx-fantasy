// The "push" Edge Function: sends the app's notifications with Web Push. Deploy it in the Supabase dashboard
// (Edge Functions), with JWT verification turned off: it checks who's calling itself. supabase/README.md has
// the steps. Secrets it needs: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (from `npx web-push generate-vapid-keys`).
//
// POST { action } with:
//   key        → { publicKey }, for the site to subscribe a device. Anyone.
//   test       → a test notification to the signed-in member's own devices.
//   post, id   → after a member posts or replies: notifies who it @mentions, the post's author for a reply, and
//                (for a new post) everyone with new-post notifications on. Only the post's author, within
//                10 minutes, once.
//   reminders  → a week's "picks lock in an hour" reminder when its lock is under an hour away, once a week.
//                Anyone (the database's predictions-reminder timer calls it when it's due; see schema.sql); it
//                does nothing until then.
//   recap      → "Week N recap is up", for the newest week in the live site's data/recaps.json, once a week.
//                Anyone (the "Recap notification" GitHub workflow calls it after a recap is published).
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE = 'https://mgdxfantasy.com/';
const PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
// The project's secret key: the newer kind (SUPABASE_SECRET_KEYS) when Supabase provides it, otherwise the
// older, deprecated service-role key.
const secretKey = (() => {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>;
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === 'string' && key) return key;
  } catch { /* not set */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
})();
const db = createClient(Deno.env.get('SUPABASE_URL')!, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
if (PUBLIC_KEY && PRIVATE_KEY) webpush.setVapidDetails(SITE, PUBLIC_KEY, PRIVATE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Device = { endpoint: string; p256dh: string; auth: string };
type Note = { title: string; body: string; url: string; tag?: string };

// Sends each device its notification; forgets devices the push service says are gone. Returns how many arrived.
async function send(list: { device: Device; note: Note }[]) {
  const results = await Promise.allSettled(list.map(({ device, note }) =>
    webpush.sendNotification({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify(note), { TTL: 6 * 3600, urgency: 'normal' })));
  let ok = 0;
  await Promise.all(results.map(async (r, i) => {
    if (r.status === 'fulfilled') { ok++; return; }
    const code = (r.reason as { statusCode?: number })?.statusCode;
    if (code === 404 || code === 410) await db.rpc('forget_push_device', { p_endpoint: list[i].device.endpoint });
    else console.error('push failed', code, String((r.reason as Error)?.message ?? r.reason));
  }));
  return ok;
}

async function caller(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.startsWith('sb_')) return null; // the publishable key alone isn't a member
  const { data, error } = await db.auth.getUser(token);
  return error ? null : data.user;
}

const snippet = (s: string, n = 110) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const lockTime = (iso: string) => new Date(iso).toLocaleString('en-US',
  { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);
  if (!PUBLIC_KEY || !PRIVATE_KEY) return reply({ error: 'The VAPID keys aren’t set up yet' }, 500);
  let input: { action?: string; id?: string } = {};
  try { input = await req.json(); } catch { /* empty body */ }

  try {
    switch (input.action) {
      case 'key':
        return reply({ publicKey: PUBLIC_KEY });

      case 'test': {
        const user = await caller(req);
        if (!user) return reply({ error: 'Sign in first' }, 401);
        const { data, error } = await db.rpc('push_user_devices', { p_user: user.id });
        if (error) throw error;
        const sent = await send((data as Device[]).map((device) => ({
          device, note: { title: 'Notifications are on', body: 'This is how MGDX notifications will look.', url: `${SITE}#/account`, tag: 'test' },
        })));
        return reply({ sent });
      }

      case 'post': {
        const user = await caller(req);
        if (!user) return reply({ error: 'Sign in first' }, 401);
        if (!/^[0-9a-f-]{36}$/i.test(input.id ?? '')) return reply({ error: 'Which post?' }, 400);
        const { data, error } = await db.rpc('push_post_recipients', { p_post: input.id, p_user: user.id });
        if (error) throw error;
        const rows = data as (Device & { reason: string; author: string; body: string; parent_id: string | null })[];
        const sent = await send(rows.map((r) => ({
          device: r,
          note: {
            title: r.reason === 'mention' ? `${r.author} mentioned you`
              : r.reason === 'reply' ? `${r.author} replied to your post` : `${r.author} posted on the Blog`,
            body: snippet(r.body) || (r.reason === 'post' ? 'Shared a picture.' : 'Tap to see it on the Main Blog.'),
            url: `${SITE}#/blog/main`,
            tag: `post-${r.parent_id ?? input.id}`,
          },
        })));
        return reply({ sent });
      }

      case 'reminders': {
        const { data, error } = await db.rpc('push_pick_recipients');
        if (error) throw error;
        const rows = data as (Device & { week: number; locks_at: string; league: string; picks: number })[];
        const sent = await send(rows.map((r) => ({
          device: r,
          note: {
            title: `Week ${r.week} picks lock in an hour`,
            body: `Predictions lock ${lockTime(r.locks_at)} ET. ${r.picks ? `You've picked ${r.picks} game${r.picks === 1 ? '' : 's'} so far.` : 'You haven’t made any picks yet.'}`,
            url: `${SITE}#/${r.league}/matchups`,
            tag: `picks-${r.week}`,
          },
        })));
        return reply({ sent, due: rows.length > 0 });
      }

      case 'recap': {
        // The week comes from the live site, so a recap only goes out once it's actually up.
        const live = await fetch(`${SITE}data/recaps.json?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
        if (!live.ok) return reply({ error: `Couldn't read the recaps (${live.status})` }, 502);
        const weeks = ((await live.json()).weeks ?? []) as { week: number }[];
        const week = Math.max(0, ...weeks.map((w) => w.week));
        if (!week) return reply({ sent: 0, due: false });
        const { data, error } = await db.rpc('push_recap_recipients', { p_week: week });
        if (error) throw error;
        const sent = await send((data as Device[]).map((device) => ({
          device,
          note: { title: `Week ${week} recap is up`, body: '', url: `${SITE}#/blog/recaps?week=${week}`, tag: `recap-${week}` },
        })));
        return reply({ week, sent, due: (data as Device[]).length > 0 });
      }

      default:
        return reply({ error: 'Unknown action' }, 400);
    }
  } catch (err) {
    console.error(err);
    return reply({ error: (err as Error).message ?? String(err) }, 500);
  }
});
