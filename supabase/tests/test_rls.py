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
    """An accepted invitation: auth user (profile made by the trigger), optionally promoted."""
    with psycopg.connect(db, autocommit=True) as c:
        uid = c.execute("insert into auth.users (email, raw_user_meta_data) values (%s, %s) returning id",
                        (email, '{"full_name": "%s"}' % email.split("@")[0])).fetchone()[0]
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
