"""
Live check against the real Supabase project: a throwaway account opens an invitation
link, sets its password, gets a cloud project saved, calls the API with its real session,
signs in again; then the account and its projects are deleted.

    SUPABASE_ACCESS_TOKEN=sbp_... .venv/bin/python frontend/e2e/live.py <project-ref>

Needs the app on http://localhost:5173 in cloud mode and the API with SUPABASE_URL set.
"""
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

REF = sys.argv[1] if len(sys.argv) > 1 else "kepelonejrqoxdfjdcgb"
BASE = f"https://{REF}.supabase.co"
tok = os.environ["SUPABASE_ACCESS_TOKEN"]
EMAIL = "verea-selftest@example.com"

def req(url, headers, body=None, method=None):
    r = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "verea-setup", **headers}, method=method)
    with urllib.request.urlopen(r, timeout=60) as f:
        t = f.read().decode()
        return json.loads(t) if t else None

keys = req(f"https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true", {"Authorization": f"Bearer {tok}"})
svc = next(k["api_key"] for k in keys if k.get("name") in ("service_role", "secret"))
H = {"apikey": svc, "Authorization": f"Bearer {svc}"}
link = req(f"{BASE}/auth/v1/admin/generate_link", H, {"type": "invite", "email": EMAIL, "redirect_to": "http://localhost:5173"}, "POST")
uid = link.get("id") or link["user"]["id"]
action = link.get("action_link") or link["properties"]["action_link"]
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": 1300, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(action)
        expect(page.get_by_text("Choose a password")).to_be_visible(timeout=30000)
        print("invite link -> set password screen: ok")
        page.get_by_label("New password (10+ characters)").fill("short")
        page.get_by_label("Repeat it").fill("short")
        page.get_by_role("button", name="Save password").click()
        expect(page.get_by_role("alert")).to_contain_text("10 characters")
        page.get_by_label("New password (10+ characters)").fill("selftest-Passw0rd-xyz")
        page.get_by_label("Repeat it").fill("selftest-Passw0rd-xyz")
        page.get_by_role("button", name="Save password").click()
        expect(page.get_by_label("Project name")).to_be_visible(timeout=30000)
        expect(page.get_by_role("status")).to_contain_text("Saved", timeout=30000)
        page.get_by_label("Project name").fill("Self-test project")
        for _ in range(30):
            rows = req(f"{BASE}/rest/v1/projects?select=name,owner_id,updated_by", H)
            mine = [r for r in rows if r["owner_id"] == uid]
            if any(r["name"] == "Self-test project" for r in mine):
                break
            time.sleep(0.5)
        assert len(mine) == 1 and mine[0]["name"] == "Self-test project", mine
        print("saved in the real database:", mine)
        # the API accepts the real session token (ES256 via JWKS)
        key = next(k for k in page.evaluate("Object.keys(localStorage)") if k.endswith("-auth-token"))
        access = json.loads(page.evaluate(f"localStorage.getItem('{key}')"))["access_token"]
        r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000/api/catalog", headers={"Authorization": f"Bearer {access}"}))
        print("API with real session:", r.status)
        # sign out, sign in with the new password
        page.get_by_role("button", name="Sign out").click()
        page.get_by_label("Email").fill(EMAIL)
        page.get_by_label("Password").fill("selftest-Passw0rd-xyz")
        page.get_by_role("button", name="Sign in").click()
        expect(page.get_by_label("Project name")).to_have_value("Self-test project", timeout=30000)
        print("sign in again, last project reopened: ok")
        print("page errors:", errors)
        b.close()
finally:
    req(f"{BASE}/rest/v1/projects?owner_id=eq.{uid}", H, method="DELETE")
    req(f"{BASE}/auth/v1/admin/users/{uid}", H, method="DELETE")
    left = req(f"{BASE}/rest/v1/profiles?select=email&id=eq.{uid}", H)
    print("cleanup: test user and projects deleted, profile left:", left)
