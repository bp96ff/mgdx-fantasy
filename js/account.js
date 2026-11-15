// Site accounts through Supabase: sign in with Google or email and password, then link the account to a
// manager with a one-time claim code (see supabase/README.md). Off until MGDX.SUPABASE has a url and key.
// app.js draws the #/account page from window.MGDX_ACCOUNT; this file keeps the header link current.
(function () {
  const cfg = (window.MGDX && window.MGDX.SUPABASE) || {};
  const enabled = Boolean(cfg.url && cfg.anonKey);
  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.min.js';
  const listeners = new Set();
  // ready: the session and manager are known. me: the linked manager (see me() in schema.sql), or null.
  let state = { ready: !enabled, user: null, me: null, recovery: false };
  let client = null;

  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn(state));
    updateHeader();
  };

  function updateHeader() {
    const link = document.getElementById('account-link');
    if (!link) return;
    link.hidden = !enabled;
    const label = !state.user ? 'Sign in' : state.me ? state.me.name : 'Link your team';
    link.querySelector('span').textContent = label;
    link.classList.toggle('signed-in', Boolean(state.me));
    link.setAttribute('aria-label', state.me ? `Your account (${state.me.name})` : label); // phones show only the icon
    link.title = state.me ? 'Your account' : '';
    // My Team: the signed-in manager's roster, while they have a team this season
    const team = document.getElementById('my-team-link');
    if (team) {
      const me = state.me;
      team.hidden = !(enabled && me && me.league);
      if (me && me.league) team.href = `#/${me.league}/rosters?team=${me.team_id}`;
    }
  }

  async function loadMe() {
    if (!state.user) return set({ me: null, ready: true });
    const { data, error } = await client.rpc('me');
    if (error) console.error(error);
    set({ me: data || null, ready: true });
  }

  // Back from Google: drop the ?code= Supabase used and land on the account page. A code only works in the
  // browser that started the sign-in, so one that didn't sign anyone in gets a note.
  function tidyUrl() {
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error_description')) return;
    const err = url.searchParams.get('error_description');
    history.replaceState(null, '', `${url.pathname}#/account`);
    if (err) set({ error: err });
    else if (!state.user) set({ error: 'That link didn’t sign you in here. If it confirmed your email, sign in below.' });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  // Email links (confirm sign-up, reset password) carry ?token_hash=&type=, set by the email templates in
  // Supabase (see supabase/README.md). Unlike ?code=, these work in any browser, such as a mail app's.
  function emailLink() {
    const url = new URL(location.href);
    const tokenHash = url.searchParams.get('token_hash');
    const type = url.searchParams.get('type');
    if (!tokenHash || !type) return;
    history.replaceState(null, '', `${url.pathname}#/account`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    client.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error }) => {
      if (error) {
        set({ error: type === 'recovery'
          ? 'That reset link has expired or was already used. Ask for a new one below.'
          : 'That link has expired or was already used. If you confirmed your email already, sign in below.' });
      } else if (type === 'recovery') set({ recovery: true });
    });
  }

  function start() {
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
    });
    emailLink();
    client.auth.onAuthStateChange((event, session) => {
      const user = session ? session.user : null;
      const changed = (user && user.id) !== (state.user && state.user.id);
      const patch = { user };
      if (event === 'PASSWORD_RECOVERY') patch.recovery = true;
      if (event === 'SIGNED_OUT') Object.assign(patch, { me: null, recovery: false });
      set(patch);
      // Supabase asks that no other auth calls run inside this callback, so the lookup waits a tick.
      if (changed || event === 'INITIAL_SESSION') setTimeout(() => loadMe().then(tidyUrl), 0);
    });
  }

  if (enabled) {
    const s = document.createElement('script');
    s.src = SDK;
    s.onload = start;
    s.onerror = () => set({ ready: true, error: 'Couldn’t reach the sign-in service. Try again later.' });
    document.head.appendChild(s);
  }
  document.addEventListener('DOMContentLoaded', updateHeader);
  updateHeader();

  const back = () => `${location.origin}${location.pathname}`;
  const check = ({ error }) => { if (error) throw error; };

  window.MGDX_ACCOUNT = {
    enabled,
    get state() { return state; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    clearError() { state = { ...state, error: null }; },
    google: async () => check(await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: back() } })),
    signIn: async (email, password) => check(await client.auth.signInWithPassword({ email, password })),
    // Returns true when Supabase wants the email confirmed before the first sign-in.
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: back() } });
      if (error) throw error;
      return !data.session;
    },
    resetPassword: async (email) => check(await client.auth.resetPasswordForEmail(email, { redirectTo: back() })),
    async updatePassword(password) {
      check(await client.auth.updateUser({ password }));
      set({ recovery: false });
    },
    signOut: async () => check(await client.auth.signOut()),
    // Resolves to null on success, or one of claim_code()'s error names.
    async claim(code) {
      const { data, error } = await client.rpc('claim_code', { p_code: code });
      if (error) throw error;
      if (data && data.error) {
        if (data.error === 'already-linked') await loadMe();
        return data.error;
      }
      set({ me: data });
      return null;
    },
  };
})();
