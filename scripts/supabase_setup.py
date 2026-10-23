"""
Configure the team's Supabase project for Verea through the Management API.

    SUPABASE_ACCESS_TOKEN=sbp_... python scripts/supabase_setup.py <project-ref> \
        --site-url http://localhost:5173 [--redirect https://verea.pages.dev] \
        [--admin you@company.com]

What it does (idempotent):
  1. applies supabase/migrations/*.sql not applied yet (tracked in public._verea_migrations);
  2. auth settings: sign-ups ON (a new account is a viewer: it sees only the projects whose
     link it opened; the team is made by invitation or by an admin), e-mail sign-ups must be
     confirmed, passwords of 10+ characters, site URL and allowed redirect URLs; Google
     sign-in when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set;
  3. with --admin: makes that existing account an admin;
  4. prints the project URL and its public (anon) key for frontend/.env.local.

The access token (Account -> Access Tokens) and the Google OAuth client are only read
from the environment and never written anywhere. Uses only the standard library.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.supabase.com/v1"
MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def call(method: str, path: str, token: str, body=None):
    req = urllib.request.Request(
        f"{API}{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "User-Agent": "verea-setup"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: HTTP {e.code} {e.read().decode()[:500]}")


def sql(ref: str, token: str, query: str):
    return call("POST", f"/projects/{ref}/database/query", token, {"query": query})


def literal(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref", help="project ref: the xxxx in https://xxxx.supabase.co")
    ap.add_argument("--site-url", required=True, help="where the app runs (links in emails go here)")
    ap.add_argument("--redirect", action="append", default=[], help="other allowed app URLs")
    ap.add_argument("--admin", help="email of an existing account to make admin")
    args = ap.parse_args()
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        print("Set SUPABASE_ACCESS_TOKEN (Supabase dashboard -> Account -> Access Tokens).")
        return 1
    ref = args.ref.removeprefix("https://").split(".")[0]

    # 1. migrations
    sql(ref, token, "create table if not exists public._verea_migrations "
                    "(name text primary key, applied_at timestamptz not null default now()); "
                    "alter table public._verea_migrations enable row level security; "
                    "revoke all on public._verea_migrations from anon, authenticated;")
    done = {r["name"] for r in sql(ref, token, "select name from public._verea_migrations") or []}
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name in done:
            print(f"  migration {f.name}: already applied")
            continue
        sql(ref, token, f"begin;\n{f.read_text()}\ninsert into public._verea_migrations (name) "
                        f"values ({literal(f.name)});\ncommit;")
        print(f"  migration {f.name}: applied")

    # 2. auth: anyone may sign in as a viewer; Google when its OAuth client is given
    urls = [args.site_url, *args.redirect]
    auth = {
        "disable_signup": False,
        "mailer_autoconfirm": False,
        "site_url": args.site_url,
        "uri_allow_list": ",".join(u.rstrip("/") + "/**" for u in urls),
        "password_min_length": 10,
    }
    gid, gsecret = os.environ.get("GOOGLE_CLIENT_ID"), os.environ.get("GOOGLE_CLIENT_SECRET")
    if gid and gsecret:
        auth |= {"external_google_enabled": True, "external_google_client_id": gid, "external_google_secret": gsecret}
    call("PATCH", f"/projects/{ref}/config/auth", token, auth)
    print(f"  auth: sign-ups as viewers, site URL {args.site_url}, redirects {', '.join(urls)}")
    print(f"  Google: {'on' if gid and gsecret else 'unchanged (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'}"
          f" · callback for the Google client: https://{ref}.supabase.co/auth/v1/callback")

    # 3. first admin
    if args.admin:
        rows = sql(ref, token, f"update public.profiles set role = 'admin' "
                               f"where lower(email) = lower({literal(args.admin)}) returning email")
        print(f"  admin: {rows[0]['email']}" if rows else f"  admin: no account {args.admin} yet "
              "(invite it from Authentication -> Users first)")

    # 4. what the frontend needs
    keys = call("GET", f"/projects/{ref}/api-keys", token) or []
    anon = next((k["api_key"] for k in keys if k.get("name") in ("anon", "publishable")), None)
    print("\nfrontend/.env.local:")
    print(f"VITE_SUPABASE_URL=https://{ref}.supabase.co")
    print(f"VITE_SUPABASE_ANON_KEY={anon or '<anon key from Project Settings -> API>'}")
    print(f"\nAPI environment: SUPABASE_URL=https://{ref}.supabase.co")
    return 0


if __name__ == "__main__":
    sys.exit(main())
