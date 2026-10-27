"""`login`, `connect` and `build`: the client's half of publishing by `git push`.

Driven through `cli.main` against a real hub, with the real `git` of the test
image, so the password git sends is the one `login` wrote into its gitconfig
and nothing else: no test here hands git a header of its own. The build is
`picky_builder`'s, which publishes the tree as it is and fails on a file named
BROKEN.
"""

import json
import os
import subprocess

import pytest
from harness import BROKEN, TOKEN, comment_payload, picky_builder, view_bytes
from modeldir import make_model, model_archive

from hammerola import config
from hammerola.cli import build_parser, main
from src.prereceive import VARIANT_NAME_REFUSAL

PID = "demo0001"
IDENTITY = {"GIT_AUTHOR_NAME": "author", "GIT_AUTHOR_EMAIL": "a@example.invalid",
            "GIT_COMMITTER_NAME": "author",
            "GIT_COMMITTER_EMAIL": "a@example.invalid",
            "GIT_CONFIG_NOSYSTEM": "1"}

pytestmark = pytest.mark.usefixtures("configured")


@pytest.fixture
def hub(hub_factory):
    return hub_factory(build_runner=picky_builder())


@pytest.fixture(autouse=True)
def logged_in(hub, monkeypatch):
    """A machine after `hammerola login`, with an identity for git."""
    for name, value in IDENTITY.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr("hammerola.setup.getpass.getpass", lambda *_a: TOKEN)
    assert main(["login", hub.url]) == 0


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *map(str, args)],
                          capture_output=True, text=True, check=True).stdout


def repository(root, directory=""):
    """A repository on `main` with the model in `directory`, committed."""
    make_model(root / directory if directory else root, pid=PID)
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "start")
    return root / directory if directory else root


def served(hub, name, path="assembled.json"):
    return hub.get(f"/project/{PID}/{name}/{path}",
                   headers={"X-Hammerola-Token": TOKEN}).content


def jobs_made(hub):
    return len(list((hub.data / "jobs").iterdir()))


def test_login_writes_git_s_headers_where_only_this_account_reads_them(
        tmp_path, capsys):
    gitconfig = config.git_settings_file()

    assert os.stat(gitconfig).st_mode & 0o777 == 0o600
    assert f'"X-Hammerola-Token: {TOKEN}"' in gitconfig.read_text()
    assert TOKEN not in capsys.readouterr().out


def test_login_behind_a_password_proxy_gives_git_its_header(
        password_proxy, monkeypatch):
    monkeypatch.setattr("builtins.input", lambda *_a: "zlo")
    monkeypatch.setattr("hammerola.setup.getpass.getpass",
                        lambda prompt: "pa:ss" if "proxy" in prompt else TOKEN)

    assert main(["login", password_proxy.url]) == 0

    text = config.git_settings_file().read_text()
    assert f'[http "{password_proxy.url}"]' in text
    assert '"Authorization: Basic emxvOnBhOnNz"' in text


def test_connect_writes_git_s_headers_on_a_machine_logged_in_before_git(
        tmp_path, capfd, monkeypatch):
    """Client 0.4.0's `login` stored the settings and wrote no gitconfig."""
    config.git_settings_file().unlink()
    monkeypatch.delenv("HUB_URL")
    monkeypatch.delenv("EDIT_TOKEN")
    root = repository(tmp_path / "work")
    capfd.readouterr()

    assert main(["-C", str(root), "connect"]) == 0

    gitconfig = config.git_settings_file()
    assert os.stat(gitconfig).st_mode & 0o777 == 0o600
    assert f'"X-Hammerola-Token: {TOKEN}"' in gitconfig.read_text()
    out, err = capfd.readouterr()
    assert TOKEN not in out + err


def test_connect_makes_the_directory_for_git_s_headers(
        hub, tmp_path, monkeypatch):
    """Settings in the environment only: the config directory never existed."""
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(tmp_path / "fresh" / "env"))
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)
    root = repository(tmp_path / "work")

    assert main(["-C", str(root), "connect"]) == 0

    gitconfig = config.git_settings_file()
    assert gitconfig.parent == tmp_path / "fresh"
    assert os.stat(gitconfig.parent).st_mode & 0o777 == 0o700
    assert f'"X-Hammerola-Token: {TOKEN}"' in gitconfig.read_text()


def test_build_publishes_the_working_copy_and_touches_nothing_of_the_author(
        hub, tmp_path):
    root = repository(tmp_path / "work")
    assert main(["-C", str(root), "connect"]) == 0
    (root / "assembled.json").write_bytes(view_bytes("staged"))
    git(root, "add", "assembled.json")
    (root / "notes.md").write_text("not committed\n")
    before = [git(root, "status", "--porcelain"), git(root, "rev-parse", "HEAD"),
              git(root, "diff", "--cached")]

    assert main(["-C", str(root), "build"]) == 0

    assert served(hub, "dev") == view_bytes("staged")
    assert served(hub, "dev", "notes.md") == b"not committed\n"
    assert [git(root, "status", "--porcelain"), git(root, "rev-parse", "HEAD"),
            git(root, "diff", "--cached")] == before

    (root / BROKEN).write_text("")
    (root / "assembled.json").write_bytes(view_bytes("broken"))
    assert main(["-C", str(root), "build"]) != 0
    assert served(hub, "dev") == view_bytes("staged")


def test_build_on_a_branch_fills_its_variant_s_slot_and_not_main_s(
        hub, tmp_path, capfd, monkeypatch):
    """Criterion 4: a worktree on its own branch has a draft of its own."""
    root = repository(tmp_path / "work")
    tree = tmp_path / "concrete-cabinet"
    git(root, "worktree", "add", "-q", "-b", "concrete-cabinet", tree)
    (tree / "assembled.json").write_bytes(view_bytes("cabinet"))
    assert main(["-C", str(tree), "connect"]) == 0

    assert main(["-C", str(tree), "build"]) == 0
    assert served(hub, "v/concrete-cabinet/dev") == view_bytes("cabinet")
    assert hub.get(f"/project/{PID}/dev/meta.json").status_code == 404
    made = jobs_made(hub)
    capfd.readouterr()

    # A later moment, so the second draft is a commit of its own: the same
    # commit pushed again would never reach the hub's hook at all.
    for name in ("GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"):
        monkeypatch.setenv(name, "2030-01-01T00:00:00Z")
    assert main(["-C", str(tree), "build"]) == 0
    out, err = capfd.readouterr()
    assert f"unchanged: /project/{PID}/v/concrete-cabinet/dev/" in err
    assert out.rstrip().endswith(
        f"{hub.url}/project/{PID}/v/concrete-cabinet/dev/")
    assert jobs_made(hub) == made


def test_build_refuses_a_detached_head_and_a_branch_no_variant_is_named(
        hub, tmp_path, capfd):
    """Criterion 5, from the client: the hub's words for the name."""
    root = repository(tmp_path / "work")
    assert main(["-C", str(root), "connect"]) == 0
    git(root, "switch", "-q", "--detach")
    capfd.readouterr()

    assert main(["-C", str(root), "build"]) == 1
    assert "HEAD is detached" in capfd.readouterr().err

    git(root, "switch", "-q", "-c", "feature/x")
    assert main(["-C", str(root), "build"]) != 0
    assert VARIANT_NAME_REFUSAL in capfd.readouterr().err


def test_the_reading_verbs_read_the_variant_of_the_branch(
        hub, tmp_path, capfd):
    """`status`, `artifacts latest` and `log dev` of a branch are its
    variant's, `status` lists the variants, and `comments` names the variant
    of a comment on its draft (criterion 8)."""
    root = repository(tmp_path / "work")
    assert main(["-C", str(root), "connect"]) == 0
    assert subprocess.run(["git", "-C", str(root), "push", f"hammerola-{PID}",
                           "main"], capture_output=True).returncode == 0
    git(root, "switch", "-q", "-c", "ceiling")
    document = json.loads((root / "project.json").read_text())
    (root / "project.json").write_text(json.dumps({**document,
                                                   "variant": "Ceiling box"}))
    (root / "lid.stl").write_bytes(b"solid ceiling\nendsolid ceiling\n")
    git(root, "commit", "-qam", "ceiling")
    ceiling = git(root, "rev-parse", "HEAD").strip()
    pushed = subprocess.run(["git", "-C", str(root), "push",
                             f"hammerola-{PID}", "ceiling"],
                            capture_output=True, text=True)
    assert pushed.returncode == 0, pushed.stderr
    (root / "assembled.json").write_bytes(view_bytes("ceiling-draft"))
    assert main(["-C", str(root), "build"]) == 0
    capfd.readouterr()

    assert main(["-C", str(root), "status"]) == 0
    out = capfd.readouterr().out
    assert f"{hub.url}/project/{PID}/v/ceiling/latest/" in out
    assert "  variant ceiling" in out
    assert f"  latest  {ceiling}" in out
    assert "variants  2" in out
    assert "* ceiling  Ceiling box" in out
    assert "  main     main" in out

    assert main(["-C", str(root), "artifacts", "latest",
                 "-o", str(tmp_path / "got")]) == 0
    assert (tmp_path / "got" / "lid.stl").read_bytes() == \
        b"solid ceiling\nendsolid ceiling\n"

    assert main(["-C", str(root), "log", "dev"]) == 0
    assert "(build, state done)" in capfd.readouterr().out

    posted = hub.post_comment(PID, "v/ceiling/dev", payload=comment_payload())
    assert posted.status_code == 201, posted.text
    assert main(["-C", str(root), "comments"]) == 0
    assert "build dev  variant ceiling" in capfd.readouterr().out


def test_status_on_a_branch_no_variant_is_named_reads_main(
        hub, tmp_path, capfd):
    """A branch the hub refuses as a variant: `connect` and `status` say so in
    the hook's words, once, advise no push, and `status` reads `main`."""
    root = repository(tmp_path / "work")
    git(root, "switch", "-q", "-c", "feat/use-cad-publish")
    capfd.readouterr()

    assert main(["-C", str(root), "connect"]) == 0
    out, err = capfd.readouterr()
    assert (out + err).count(VARIANT_NAME_REFUSAL) == 1
    assert "git push" not in out + err

    assert main(["-C", str(root), "status"]) == 0
    out, err = capfd.readouterr()
    assert err.count(VARIANT_NAME_REFUSAL) == 1
    assert "git push" not in out + err
    assert f"  {hub.url}/project/{PID}/\n" in out
    assert "  variant main" in out

    assert subprocess.run(["git", "-C", str(root), "push", f"hammerola-{PID}",
                           "main"], capture_output=True).returncode == 0
    assert main(["-C", str(root), "status"]) == 0
    assert f"  latest  {git(root, 'rev-parse', 'main').strip()}" in \
        capfd.readouterr().out


def test_build_without_connect_says_to_connect(tmp_path, capsys):
    root = repository(tmp_path / "work")

    assert main(["-C", str(root), "build"]) == 1
    assert "run `hammerola connect`" in capsys.readouterr().err


def test_connect_joins_the_published_history_into_main_from_a_worktree(
        hub, tmp_path, capsys):
    """A project published before git, in `hub/` of a repository whose agent
    works in a worktree on another branch (criteria 11 and 12)."""
    old = make_model(tmp_path / "old", pid=PID)
    assert hub.publish(PID, "cards-2026-09-14", model_archive(old)
                       ).status_code == 201
    (old / "model.py").write_text("BOX = 12\n")
    digest_reply = hub.publish(PID, None, model_archive(old))
    digest = digest_reply.json()["url"].rstrip("/").rsplit("/", 1)[1]

    work = tmp_path / "work"
    repository(work, "hub")
    (work / "hub" / "model.py").write_text("BOX = 14\n")
    git(work, "commit", "-q", "-am", "wider box")
    tree = tmp_path / "wt"
    git(work, "worktree", "add", "-q", "-b", "concrete-cabinet", tree)
    main_before = git(work, "rev-parse", "main").strip()
    branch_head = git(tree, "rev-parse", "HEAD")

    assert main(["-C", str(tree / "hub"), "connect"]) == 0
    assert f"git push hammerola-{PID} concrete-cabinet" in \
        capsys.readouterr().out

    parents = git(work, "rev-list", "--parents", "-n1", "main").split()
    assert parents[1] == main_before and len(parents) == 3
    assert git(work, "diff", "main~1", "main") == ""
    assert git(work, "status", "--porcelain") == ""
    assert git(tree, "branch", "--show-current").strip() == "concrete-cabinet"
    assert git(tree, "rev-parse", "HEAD") == branch_head

    pushed = subprocess.run(["git", "-C", str(work), "push",
                             f"hammerola-{PID}", "main"],
                            capture_output=True, text=True)
    assert pushed.returncode == 0, pushed.stderr
    # The join changed no file of the project, so the revision is the commit
    # under it.
    new = git(work, "rev-parse", "main~1").strip()
    assert f"published: /project/{PID}/{new}/" in pushed.stderr

    assert main(["-C", str(tree / "hub"), "diff", "cards-2026-09-14",
                 digest]) == 0
    code = capsys.readouterr().out.split("code:", 1)[1]
    assert "+BOX = 12" in code and "new file" not in code

    assert main(["-C", str(tree / "hub"), "diff", digest, new]) == 0
    code = capsys.readouterr().out.split("code:", 1)[1]
    assert "-BOX = 12" in code and "+BOX = 14" in code
    assert "new file" not in code

    assert main(["-C", str(tree / "hub"), "log", "cards-2026-09-14"]) == 0
    assert "--- build log of cards-2026-09-14 ---" in capsys.readouterr().out


def test_diff_reads_the_project_where_each_revision_had_it(
        hub, tmp_path, capsys):
    work = tmp_path / "work"
    repository(work, "hub")
    assert main(["-C", str(work / "hub"), "connect"]) == 0
    git(work, "push", "-q", f"hammerola-{PID}", "main")
    before = git(work, "rev-parse", "HEAD").strip()
    for path in sorted((work / "hub").iterdir()):
        git(work, "mv", f"hub/{path.name}", path.name)
    (work / "model.py").write_text("BOX = 14\n")
    git(work, "commit", "-q", "-am", "the project to the root")
    git(work, "push", "-q", f"hammerola-{PID}", "main")
    after = git(work, "rev-parse", "HEAD").strip()
    capsys.readouterr()

    assert main(["-C", str(work), "diff", before, after]) == 0

    code = capsys.readouterr().out.split("code:", 1)[1]
    assert "+BOX = 14" in code
    assert "hub/" not in code and "new file" not in code


def test_diff_names_the_fetch_for_a_revision_it_does_not_have(
        hub, tmp_path, capsys):
    root = repository(tmp_path / "work")
    assert hub.publish(PID, "c1", model_archive(root)).status_code == 201
    assert hub.publish(PID, "c2", model_archive(root)).status_code == 201

    assert main(["-C", str(root), "diff", "c1", "c2"]) == 1
    assert f"git fetch hammerola-{PID}" in capsys.readouterr().err


def test_the_archive_verbs_are_not_offered():
    """Answered when typed, but not listed among the commands."""
    usage = build_parser().format_usage()
    assert "commit" not in usage and "source" not in usage
    assert "connect" in usage


@pytest.mark.parametrize("argv,instead", [
    (["commit", "-m", "a wider box"], "`git push hammerola-<pid> main`"),
    (["source", "latest", "-o", "old"], "`git fetch hammerola-<pid>`"),
])
def test_the_archive_verbs_are_gone(argv, instead, capsys):
    """Typed as an old skill taught them, flags included, they name what
    replaced them and the stale skill, not argparse's `invalid choice`."""
    assert main(argv) == 1
    error = capsys.readouterr().err
    assert f"`hammerola {argv[0]}` was removed in version 0.5.0" in error
    assert "`hammerola connect`" in error and instead in error
    assert "run `hammerola skill update` and read it again" in error
