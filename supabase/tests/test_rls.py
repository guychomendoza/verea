"""
Row level security of the Verea database, on a real PostgreSQL (pgserver) with a
Supabase stand-in (supabase_shim.sql). Run: .venv/bin/python -m pytest supabase/tests
Needs requirements-dev.txt (pgserver, psycopg).
"""

import uuid
from pathlib import Path

import pytest

pgserver = pytest.importorskip("pgserver")
psycopg = pytest.importorskip("psycopg")

HERE = Path(__file__).resolve().parent
MIGRATIONS = sorted((HERE.parent / "migrations").glob("*.sql"))


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    srv = pgserver.get_server(tmp_path_factory.mktemp("pg"), cleanup_mode="stop")
    url = srv.get_uri()
    with psycopg.connect(url, autocommit=True) as c:
        c.execute((HERE / "supabase_shim.sql").read_text())
        for m in MIGRATIONS:
            c.execute(m.read_text())
    yield url
    srv.cleanup()


def new_user(db, email, role="member", active=True):
    """An accepted invitation (or, for a viewer, a Google sign-up): auth user, profile made by
    the trigger, optionally promoted or deactivated."""
    with psycopg.connect(db, autocommit=True) as c:
        uid = c.execute("insert into auth.users (email, raw_user_meta_data, invited_at) values (%s, %s, %s) "
                        "returning id", (email, '{"full_name": "%s"}' % email.split("@")[0],
                                         None if role == "viewer" else "now")).fetchone()[0]
        c.execute("update public.profiles set role = %s, active = %s where id = %s", (role, active, uid))
    return uid


class As:
    """A connection acting as an API caller: anon, or authenticated with a user id."""

    def __init__(self, db, uid=None):
        self.c = psycopg.connect(db, autocommit=True)
        self.c.execute("set role " + ("authenticated" if uid else "anon"))
        if uid:
            self.c.execute("select set_config('request.jwt.claim.sub', %s, false)", (str(uid),))

    def q(self, sql, *args):
        cur = self.c.execute(sql, args)
        return cur.fetchall() if cur.description else cur.rowcount


@pytest.fixture(scope="module")
def team(db):
    return {"ana": new_user(db, "ana@farm.mx"), "beto": new_user(db, "beto@farm.mx"),
            "admin": new_user(db, "jefa@farm.mx", role="admin"),
            "ex": new_user(db, "ex@farm.mx", active=False)}


def create(db, uid, name="Rancho"):
    return As(db, uid).q("insert into projects (name, data) values (%s, '{\"nodes\": []}') "
                         "returning id, owner_id, updated_by", name)[0]


def test_trigger_makes_member_profiles(db, team):
    rows = As(db, team["ana"]).q("select email, full_name, role from profiles order by email")
    assert ("ana@farm.mx", "ana", "member") in rows and ("jefa@farm.mx", "jefa", "admin") in rows


def test_anonymous_sees_nothing(db, team):
    create(db, team["ana"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        As(db).q("select * from projects")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        As(db).q("select * from profiles")


def test_non_members_see_nothing(db, team):
    stranger = uuid.uuid4()                    # valid token, no profile
    assert As(db, stranger).q("select * from projects") == []
    assert As(db, team["ex"]).q("select * from projects") == []          # deactivated member
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        As(db, team["ex"]).q("insert into projects (name, data) values ('x', '{}')")


def test_everyone_in_the_team_reads_and_edits(db, team):
    pid, owner, by = create(db, team["ana"], "Huerta")
    assert owner == by == team["ana"]
    beto = As(db, team["beto"])
    assert beto.q("select name from projects where id = %s", pid) == [("Huerta",)]
    assert beto.q("update projects set name = 'Huerta norte' where id = %s", pid) == 1
    assert beto.q("select updated_by, owner_id from projects where id = %s", pid) == [(team["beto"], team["ana"])]


def test_owner_cannot_be_spoofed_or_changed(db, team):
    ana = As(db, team["ana"])
    pid, owner, _ = ana.q("insert into projects (name, data, owner_id) values ('x', '{}', %s) "
                          "returning id, owner_id, updated_by", team["beto"])[0]
    assert owner == team["ana"]
    with pytest.raises(psycopg.errors.RaiseException):
        ana.q("update projects set owner_id = %s where id = %s", team["beto"], pid)
    assert As(db, team["admin"]).q("update projects set owner_id = %s where id = %s", team["beto"], pid) == 1


def test_only_owner_or_admin_deletes(db, team):
    pid, *_ = create(db, team["ana"])
    assert As(db, team["beto"]).q("delete from projects where id = %s", pid) == 0
    assert As(db, team["ana"]).q("delete from projects where id = %s", pid) == 1
    pid, *_ = create(db, team["ana"])
    assert As(db, team["admin"]).q("delete from projects where id = %s", pid) == 1


def test_saves_based_on_a_stale_copy_fail(db, team):
    """Optimistic locking: the app saves with the updated_at it loaded."""
    pid, *_ = create(db, team["ana"])
    ana, beto = As(db, team["ana"]), As(db, team["beto"])
    loaded = ana.q("select updated_at from projects where id = %s", pid)[0][0]
    assert beto.q("update projects set name = 'B' where id = %s", pid) == 1
    assert ana.q("update projects set name = 'A' where id = %s and updated_at = %s", pid, loaded) == 0
    assert ana.q("select name from projects where id = %s", pid) == [("B",)]


def test_members_cannot_promote_themselves(db, team):
    ana = As(db, team["ana"])
    assert ana.q("update profiles set full_name = 'Ana López' where id = %s", team["ana"]) == 1
    with pytest.raises(psycopg.errors.RaiseException):
        ana.q("update profiles set role = 'admin' where id = %s", team["ana"])
    assert ana.q("update profiles set full_name = 'x' where id = %s", team["beto"]) == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ana.q("insert into profiles (id, email) values (%s, 'fake@x.mx')", uuid.uuid4())
    admin = As(db, team["admin"])
    assert admin.q("update profiles set active = false where id = %s", team["beto"]) == 1
    assert As(db, team["beto"]).q("select * from projects") == []
    admin.q("update profiles set active = true where id = %s", team["beto"])


def test_project_size_and_shape_are_checked(db, team):
    ana = As(db, team["ana"])
    with pytest.raises(psycopg.errors.CheckViolation):
        ana.q("insert into projects (name, data) values ('x', '[]')")
    with pytest.raises(psycopg.errors.CheckViolation):
        ana.q("insert into projects (name, data) values (%s, '{}')", "n" * 121)


def test_deleting_an_editor_clears_last_edited_by(db, team):
    temp = new_user(db, "temp@farm.mx")
    pid, *_ = create(db, team["ana"])
    As(db, temp).q("update projects set name = 'touched' where id = %s", pid)
    with psycopg.connect(db, autocommit=True) as c:
        c.execute("delete from auth.users where id = %s", (temp,))
        assert c.execute("select name, updated_by from projects where id = %s", (pid,)).fetchone() == ("touched", None)


# ── viewers and shared links ──

# Refusals from the viewer functions (no access / unknown or revoked link / team account)
DENIED = (psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound, psycopg.errors.RaiseException)

PROJECT = ('{"nodes": [{"name": "AGU-D0311 Alfonso Maciel Guz", "owner": "Alfonso Maciel Guzman", '
           '"area_ha": 2.5, "plot": "p1", "height": 2.5}, {"name": "N-2", "height": 1.5}], '
           '"plots": [{"id": "p1"}], "gateways": []}')


@pytest.fixture(scope="module")
def shared(db, team):
    """A project with a link that hides owner info and one that shows it, and two viewers."""
    ana = As(db, team["ana"])
    pid = ana.q("insert into projects (name, data) values ('Tamazula', %s) returning id", PROJECT)[0][0]
    hidden = ana.q("insert into project_shares (project_id) values (%s) returning token", pid)[0][0]
    full = ana.q("insert into project_shares (project_id, show_owner_info) values (%s, true) returning token",
                 pid)[0][0]
    return {"pid": pid, "hidden": hidden, "full": full,
            "vera": new_user(db, "vera@cliente.mx", role="viewer"),
            "otto": new_user(db, "otto@cliente.mx", role="viewer")}


def test_google_sign_ups_are_viewers_and_invitations_members(db):
    with psycopg.connect(db, autocommit=True) as c:
        g = c.execute("""insert into auth.users (email, raw_user_meta_data) values ('g@gmail.com', '{"name": "Gil"}')
                         returning id""").fetchone()[0]
        i = c.execute("insert into auth.users (email, invited_at) values ('i@farm.mx', now()) returning id").fetchone()[0]
        rows = dict(c.execute("select id, (role, full_name) from profiles where id in (%s, %s)", (g, i)).fetchall())
    assert rows[g] == ("viewer", "Gil") and rows[i][0] == "member"


def test_viewers_see_no_team_projects_or_profiles(db, team, shared):
    vera = As(db, shared["vera"])
    assert vera.q("select * from projects") == []
    assert vera.q("select email from profiles") == [("vera@cliente.mx",)]
    assert vera.q("select * from project_shares") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        vera.q("insert into projects (name, data) values ('x', '{}')")
    with pytest.raises(DENIED):
        vera.q("select viewer_project(%s)", shared["pid"])          # no link opened yet
    assert vera.q("select * from my_files()") == []


def test_a_link_gives_read_access_without_owner_info(db, team, shared):
    vera = As(db, shared["vera"])
    assert vera.q("select claim_share(%s)", shared["hidden"]) == [(shared["pid"],)]
    v = vera.q("select viewer_project(%s)", shared["pid"])[0][0]
    assert v["name"] == "Tamazula" and v["token"] == shared["hidden"] and v["show_owner_info"] is False
    n0 = v["data"]["nodes"][0]
    assert n0 == {"name": "AGU-D0311", "height": 2.5} and "plots" not in v["data"]
    assert [r[1] for r in vera.q("select * from my_files()")] == ["Tamazula"]
    # Still no direct access, no editing, no deleting
    assert vera.q("select * from projects") == []
    assert vera.q("update projects set name = 'mío' where id = %s", shared["pid"]) == 0
    assert vera.q("delete from projects where id = %s", shared["pid"]) == 0


def test_a_link_that_shows_owner_info(db, team, shared):
    otto = As(db, shared["otto"])
    otto.q("select claim_share(%s)", shared["full"])
    d = otto.q("select viewer_project(%s)", shared["pid"])[0][0]["data"]
    assert d["nodes"][0]["owner"] == "Alfonso Maciel Guzman" and d["plots"] == [{"id": "p1"}]


def test_viewers_keep_their_own_changes(db, team, shared):
    vera, otto = As(db, shared["vera"]), As(db, shared["otto"])
    vera.q("select claim_share(%s)", shared["hidden"])
    otto.q("select claim_share(%s)", shared["full"])
    assert vera.q("""update project_viewers set overrides = '{"N-2": {"height": 4}}' where project_id = %s""",
                  shared["pid"]) == 1
    assert otto.q("select overrides from project_viewers where user_id = %s", shared["vera"]) == []
    assert otto.q("""update project_viewers set overrides = '{}' where user_id = %s""", shared["vera"]) == 0
    assert vera.q("select viewer_project(%s)", shared["pid"])[0][0]["overrides"] == {"N-2": {"height": 4}}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        vera.q("update project_viewers set share_id = null where project_id = %s", shared["pid"])
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        vera.q("insert into project_viewers (project_id, user_id) values (%s, %s)", shared["pid"], shared["vera"])
    # The team sees who has access (for follow-up) and the original never changed
    ana = As(db, team["ana"])
    assert len(ana.q("select user_id from project_viewers where project_id = %s", shared["pid"])) == 2
    assert ana.q("select data -> 'nodes' -> 1 ->> 'height' from projects where id = %s", shared["pid"]) == [("1.5",)]


def test_viewers_cannot_promote_themselves_but_edit_their_profile(db, shared):
    vera = As(db, shared["vera"])
    assert vera.q("update profiles set full_name = 'Vera R', phone = '33 1234', company = 'Agro' "
                  "where id = %s", shared["vera"]) == 1
    with pytest.raises(psycopg.errors.RaiseException):
        vera.q("update profiles set role = 'member' where id = %s", shared["vera"])
    with pytest.raises(psycopg.errors.CheckViolation):
        vera.q("update profiles set phone = %s where id = %s", "1" * 41, shared["vera"])


def test_links_can_be_revoked_and_access_removed(db, team, shared):
    ana = As(db, team["ana"])
    pid = ana.q("insert into projects (name, data) values ('Otro', '{}') returning id")[0][0]
    tok = ana.q("insert into project_shares (project_id) values (%s) returning token", pid)[0][0]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ana.q("insert into project_shares (project_id, token) values (%s, 'adivinable')", pid)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        As(db, shared["vera"]).q("insert into project_shares (project_id) values (%s)", pid)
    otto = As(db, shared["otto"])
    otto.q("select claim_share(%s)", tok)
    assert ana.q("update project_shares set revoked_at = now() where token = %s", tok) == 1
    assert otto.q("select viewer_project(%s)", pid)[0][0]["token"] is None    # kept, link gone
    with pytest.raises(DENIED):
        As(db, shared["vera"]).q("select claim_share(%s)", tok)              # no new access
    assert ana.q("delete from project_viewers where project_id = %s and user_id = %s", pid, shared["otto"]) == 1
    with pytest.raises(DENIED):
        otto.q("select viewer_project(%s)", pid)
    with pytest.raises(DENIED):
        otto.q("select claim_share('no-existe')")


def test_deactivated_viewers_lose_access(db, team, shared):
    As(db, shared["vera"]).q("select claim_share(%s)", shared["hidden"])
    As(db, team["admin"]).q("update profiles set active = false where id = %s", shared["vera"])
    with pytest.raises(DENIED):
        As(db, shared["vera"]).q("select viewer_project(%s)", shared["pid"])
    assert As(db, shared["vera"]).q("select * from my_files()") == []
    As(db, team["admin"]).q("update profiles set active = true where id = %s", shared["vera"])


def test_only_viewers_delete_their_own_account(db, team):
    gone = new_user(db, "adios@cliente.mx", role="viewer")
    with pytest.raises(DENIED):
        As(db, team["ana"]).q("select delete_my_account()")
    As(db, gone).q("select delete_my_account()")
    with psycopg.connect(db, autocommit=True) as c:
        assert c.execute("select count(*) from profiles where id = %s", (gone,)).fetchone() == (0,)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        As(db).q("select delete_my_account()")
