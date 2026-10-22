# Verea database (Supabase)

One company workspace: every **active member** opens and edits every project; only
its owner or an admin deletes it. Accounts are **invite-only**.

- `migrations/` — tables (`profiles`, `projects`), triggers and row level security.
- `tests/` — the rules tested on a real PostgreSQL (`pip install -r requirements-dev.txt`,
  then `pytest supabase/tests`): anonymous and non-members see nothing, members cannot
  make themselves admin or fake the owner, stale saves are refused (optimistic locking).

## Setup (once)

1. Create the project at supabase.com; create an access token (Account → Access Tokens).
2. `SUPABASE_ACCESS_TOKEN=sbp_... python scripts/supabase_setup.py <ref> --site-url <app URL>`
   applies the migrations, turns sign-ups off and prints the values for `frontend/.env.local`.
3. Set `SUPABASE_URL` in the API environment.

## Managing the team (dashboard)

- **Invite:** Authentication → Users → Invite user. The email link opens Verea, which asks
  for a password (10+ characters). The new account is a `member`.
- **Make admin:** SQL editor: `update profiles set role = 'admin' where email = 'x@y.mx';`
  (or `scripts/supabase_setup.py <ref> --site-url ... --admin x@y.mx`).
- **Remove access:** `update profiles set active = false where email = 'x@y.mx';` — the
  person can no longer read or save anything; their projects stay for the team.
