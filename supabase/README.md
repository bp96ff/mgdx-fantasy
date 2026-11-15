# Manager accounts (Supabase)

Managers sign in on the site's **Your Account** page (`#/account`) with Google or with an email and password.
Then they enter a one-time claim code that links the account to their manager. Members-only features check
that link. Only managers in the current season count as members. Bryce, Kat and Laith are moderators.

| File | What it is |
|---|---|
| `schema.sql` | Tables, access rules and the claim-code functions. Run once, and again whenever it changes. |
| `seed-<season>.sql` | That season's managers and teams. Made by `node tools/build-supabase-seed.js` from `data/standings.json`. |
| `js/account.js` | The site's sign-in code. Turned on by `SUPABASE.url` and `SUPABASE.anonKey` in `js/config.js`. |

Claim codes are never saved in this repo. They only exist in the Supabase database.

## One-time setup

### 1. Create the project
1. Sign up at supabase.com and create a project. Pick a region near the league (East US) and save the
   database password somewhere safe.
2. Open **SQL Editor**, paste all of `schema.sql`, and run it.
3. In a new query, paste all of `seed-2026.sql` and run it. The result is every manager's claim code. Copy
   it somewhere private, like a note on your phone. You can list the codes again any time (see below).

### 2. Connect the site
1. **Project Settings → API**: copy the **Project URL** and the **anon public** key. Send both to Claude
   to put in `js/config.js`. The anon key is meant to be public; never share the **service_role** key.
2. **Authentication → URL Configuration**:
   - Site URL: `https://mgdxfantasy.com`
   - Redirect URLs: add `https://mgdxfantasy.com/**` and `http://localhost:8080/**`

### 3. Google sign-in
1. At console.cloud.google.com, create a project (for example "MGDX Fantasy").
2. **APIs & Services → OAuth consent screen**: choose External. Set the app name to Microgen Fantasy
   Football and add your support email. Add `mgdxfantasy.com` as an authorized domain. Then publish the
   app ("In production"), so anyone can sign in, not just test users. The basic email and profile access
   it asks for doesn't need Google's review.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type Web application:
   - Authorized JavaScript origins: `https://mgdxfantasy.com`
   - Authorized redirect URI: the callback URL Supabase shows under **Authentication → Providers →
     Google** (`https://<project-ref>.supabase.co/auth/v1/callback`)
4. Copy the client ID and client secret into Supabase under **Authentication → Providers → Google**, and
   turn the provider on.

### 4. Email (for sign-up confirmations and password resets)
Supabase's built-in sender only delivers to members of your Supabase team, and only a few emails an hour.
So email-and-password sign-ups need your own sender:
1. Make a free account at resend.com and add the domain `mgdxfantasy.com`. Resend lists a few DNS records;
   add them where the domain is registered, then wait for Resend to show the domain as verified.
2. Create a Resend API key.
3. In Supabase, go to **Authentication → Emails → SMTP Settings** and turn on custom SMTP:
   - host `smtp.resend.com`, port `465`, username `resend`, password = the API key
   - sender email `no-reply@mgdxfantasy.com`, sender name `MGDX Fantasy`

4. Under **Authentication → Emails → Templates**, change the link in two templates so it works in any
   browser, including a mail app's built-in one. In each, replace `{{ .ConfirmationURL }}` (it appears
   inside `href="..."`) with:
   - **Confirm signup:** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`
   - **Reset password:** `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery`
5. Under **Authentication → Rate Limits**, raise emails per hour to about 30.

Until this is done, Google sign-in still works.

### 5. GIF search (GIPHY)
1. Make a free account at developers.giphy.com, then **Create an API Key** → choose **API** (not SDK).
2. Send the key to Claude to put in `GIPHY_KEY` in `js/config.js`. Like the anon key, it's meant to be public.

A new key allows 100 searches an hour for the whole site. If that runs out, GIPHY's dashboard can upgrade it.
Without a key, the GIF button is hidden; uploading photos and GIFs still works.

## Each season
Once `data/standings.json` has the new season's teams:

    node tools/build-supabase-seed.js

Run the new `seed-<season>.sql` in the SQL editor. Returning managers keep their accounts. New managers
get codes, which the last query lists. Managers who left can still sign in, but they're no longer members.

A manager is matched by name from season to season. If a returning manager's ESPN name changes, set it
back with `ownerNames` in `js/config.js`.

## Handy SQL (run in the SQL editor)

List every current code and whether it's been used:

    select * from public.new_claim_codes();

Give a manager a new code, for a lost code or the wrong person claiming it. The second line unlinks any
account that used the old code.

    delete from public.claim_codes where manager_id = 'bryce';
    delete from public.profiles where manager_id = 'bryce';
    select * from public.new_claim_codes();

Change moderators. The seed sets them too; edit `MODERATORS` in `tools/build-supabase-seed.js` to make a
change stick:

    update public.managers set is_moderator = true where id = 'kat';
