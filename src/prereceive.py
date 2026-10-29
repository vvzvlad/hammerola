"""The answer to the pre-receive hook: may this push go in?

git runs `githooks/pre-receive` once the pushed objects are in the repository's
quarantine and before any ref moves. The hook decides nothing: it posts the ref
updates to `POST /internal/pre-receive` (src/app.py) and prints what comes back.
This module is that answer, written one line at a time as the push goes; the
last line is the verdict, `hammerola-verdict: ok` or `hammerola-verdict:
refused`, and the hook exits 0 or 1 on it.

Two passes over the refs:

* the first only looks — the ref's name, fast-forward, the project's directory
  (the one holding a project.json with this project's id), symlinks and
  submodules in it. A refusal here refuses the push before anything is built;
* the second builds, one ref after another, in the ordinary queue (src/jobs.py),
  and prints each build's log whole once it ends, then how long it took. The
  first failed build refuses the push; what published before it stays a
  revision.

A branch is a variant of the project. It publishes the newest commit of its
first-parent line after the old tip that touched the project's directory,
under its sha, unless that commit is built already; its `latest` follows the
branch once git has written it (`githttp.end_of_request`). When the variant's
draft slot holds that commit's tree, the slot's build is published under the
sha and nothing is built, unless the draft was built with `-o force` and the
push is not (`Store.promote_dev`). A draft,
`refs/drafts/<variant>`, publishes its commit into that variant's `dev` slot,
whether or not the hub has the branch yet. A variant's name is the branch's,
held to `SAFE_ID`: it is a segment of the variant's address.

A deleted branch takes its variant with it, except `main`, whose deletion is
refused as any other ref's is. The answer only queues the variant
(`Store.queue_variant_removal`): git deletes the ref after it and the push can
still fail, so the variant goes at the end of the request
(`githttp.end_of_request`).

No lock of its own: git writes the ref, and of two pushes racing for one branch
the loser gets `! [remote rejected]` with its revision already published.

A name changed on the page — the project's, a variant's, a view's or a
document's — reaches the branch the same way (`commit_name`): the hub commits
it into project.json on the branch's tip, publishes that commit, and moves the
branch onto it once it has. A name is text the build only carries, so the
commit is published as a copy of a build of the tip's project with the name
rewritten; only a tip whose project tree neither the tip's own build nor the
variant's `latest` holds is built, as a pushed commit is.
"""

import json
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from datetime import datetime

from loguru import logger

from hammerola.buildnames import first_nonprintable
from src import render
from src.buildproc import STATUS_CPU_EXHAUSTED, STATUS_TIMEOUT
from src.docsbuild import DOCUMENTS_FIELD, VIEWS_FIELD, project_names
from src.errors import PublishError
from src.jobs import (HANDOVER_ERROR, QUEUE_FULL_ERROR, STATE_DONE,
                      STATE_FAILED, SUBMIT_ACCEPTED, SUBMIT_QUEUE_FULL,
                      BuildTask)
from src.store import (BRANCH_PREFIX, DEV_LINK, DRAFT_PREFIX, JSON_TMP_PREFIX,
                       MAIN_BRANCH, MAIN_REF, PAYLOAD_DIGEST_FILE,
                       SOURCE_PREFIX, Store, build_path, git_failure,
                       published_stamp, run_git)

# What git writes for a ref that does not exist on one side of an update.
ZERO = "0" * 40

# The refusal of a branch or a draft whose name cannot be a variant's.
VARIANT_NAME_REFUSAL = ("variant (branch) name must be letters, digits, - and "
                        "_, up to 64")

# The refusal of a push deleting the default variant's branch.
MAIN_DELETION_REFUSAL = (f"the default variant {MAIN_BRANCH} cannot be deleted; "
                         f"hammerola rm removes the whole project")

PROJECT_FILE = "project.json"

# Who the commits the hub makes itself are by: a name changed on the page
# (`commit_name`), so `git log` tells them from the author's own.
HUB_IDENTITY = {"GIT_AUTHOR_NAME": "hammerola hub",
                "GIT_AUTHOR_EMAIL": "hub@hammerola.invalid",
                "GIT_COMMITTER_NAME": "hammerola hub",
                "GIT_COMMITTER_EMAIL": "hub@hammerola.invalid"}

# `git ls-tree` modes the build cannot take: a symlink and a submodule.
LINK_MODES = ("120000", "160000")

# The environment git gives the hook for the objects of a push not yet
# accepted; every git command here runs with it, to see them.
QUARANTINE_VARIABLES = ("GIT_QUARANTINE_PATH", "GIT_OBJECT_DIRECTORY",
                        "GIT_ALTERNATE_OBJECT_DIRECTORIES")

# `git push -o force` skips the model's own checks().
FORCE_OPTION = "force"

# The last line of every answer; githooks/pre-receive exits on it.
VERDICT = "hammerola-verdict: "
ACCEPTED = "ok"
REFUSED = "refused"

# How often the answer looks at the job it waits for.
POLL_SECONDS = 0.05

# When a build is slow enough to warn about. A judgement, not a fraction of
# buildproc's `wall_seconds`. Said here, after the log, rather than by the
# build, because the hub keeps only the head of a log
# (`buildproc.runner._Drain`) and a warning at the end of a long log would be
# dropped.
SLOW_BUILD_SECONDS = 180

# Endings that already carry their own diagnosis, so no slow-build warning.
SELF_DIAGNOSING = (STATUS_TIMEOUT, STATUS_CPU_EXHAUSTED)

# The stamps a job record carries (`store.utcnow_iso`).
STAMP = "%Y-%m-%dT%H:%M:%SZ"

SLOW_BUILD_WARNING = (
    "warning: {took} is over the {limit} a build should need. It published —\n"
    "  this is a warning and not a refusal.\n"
    "  Most of a slow build is checks(): ask about a point with\n"
    "  `checklib.material_at` rather than a boolean intersect, put `@cache` "
    "on the\n"
    "  builders, and do not filter pairs by hand in front of "
    "`pairwise_interference`.\n"
    "  \"Keeping checks fast enough to run\", in the skill's\n"
    "  references/checks.md, has all three.")


class Refused(Exception):
    """A ref this push may not carry. The message is the phrase the pusher reads."""

    def __init__(self, ref: str, why: str):
        super().__init__(why)
        self.ref = ref


class NotThere(Exception):
    """A view or a document a rename names that the variant does not have."""


@dataclass(frozen=True)
class HookRequest:
    """One call of the hook, checked: what `parse` hands to `run`."""

    pid: str
    updates: tuple       # ((old, new, ref), ...), as git gave them
    quarantine: dict     # QUARANTINE_VARIABLES that were set
    options: tuple       # the push options


@dataclass(frozen=True)
class Plan:
    """What the second pass does for one ref."""

    ref: str
    draft: bool
    directory: str       # the project's directory in the commit, "" for the root
    target: str | None   # the commit to build, None for nothing
    variant: str         # the branch, or the variant of the draft
    unchanged: bool = False
    delete: bool = False  # the branch is deleted, and its variant goes with it


def parse(body: bytes, store: Store) -> HookRequest:
    """The hook's JSON body, checked. Raises ValueError saying what is wrong."""
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError(f"the body is not JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("the body is not a JSON object")
    pid = payload.get("pid")
    if not isinstance(pid, str) or not store.valid_pid(pid) \
            or not store.repo_dir(pid).is_dir():
        raise ValueError("no such repository")
    lines = payload.get("lines")
    if not isinstance(lines, list) or not all(isinstance(line, str)
                                              for line in lines):
        raise ValueError("`lines` must be a list of strings")
    updates = []
    for line in lines:
        fields = line.split()
        if len(fields) != 3:
            raise ValueError(f"not a ref update: {line!r}")
        updates.append(tuple(fields))
    quarantine = payload.get("quarantine")
    if not isinstance(quarantine, dict) or not all(
            key in QUARANTINE_VARIABLES and isinstance(value, str)
            for key, value in quarantine.items()):
        raise ValueError("`quarantine` must map git's quarantine variables")
    options = payload.get("options")
    if not isinstance(options, list) or not all(isinstance(option, str)
                                                for option in options):
        raise ValueError("`options` must be a list of strings")
    return HookRequest(pid, tuple(updates), dict(quarantine), tuple(options))


def run(store: Store, jobs, builds, request: HookRequest, say) -> bool:
    """Answer one push, line by line through `say`. -> whether it may go in.

    The verdict line is the caller's to write. Every refusal is one phrase to
    the pusher and the line `push <pid> <ref>: refused: <why>` in the log.
    """
    repo = store.repo_dir(request.pid)
    env = request.quarantine
    try:
        plans = [plan for old, new, ref in request.updates
                 if (plan := _look(store, repo, request.pid, env, old, new, ref))]
        force = FORCE_OPTION in request.options
        for plan in plans:
            if plan.unchanged:
                say(f"unchanged: "
                    f"{build_path(request.pid, DEV_LINK, plan.variant)}")
            elif plan.target is not None and (
                    plan.draft
                    or store.built_build(request.pid, plan.target, env) is None):
                # Asked again for a branch: an earlier ref of this push, a
                # second branch at the same commit, may have built it.
                if not plan.draft and _reuse_draft(store, jobs, repo,
                                                   request.pid, env, plan,
                                                   force, say):
                    continue
                _build(store, jobs, builds, repo, request.pid, env, plan, force,
                       say)
    except Refused as refusal:
        logger.warning(f"push {request.pid} {refusal.ref}: refused: {refusal}")
        say(str(refusal))
        return False
    # The commit each deleted branch stands on: what only it reached goes
    # (`Store.remove_variant`).
    tips = {ref: old for old, new, ref in request.updates}
    for plan in plans:
        if plan.delete:
            say(f"removing the variant {plan.variant} with every revision no "
                f"other variant has")
            store.queue_variant_removal(request.pid, plan.variant,
                                        tips[plan.ref])
    return True


def _look(store: Store, repo, pid: str, env: dict, old: str, new: str,
          ref: str) -> Plan | None:
    """The first pass over one ref: refuse it, or say what to build for it."""
    if new == ZERO:
        if ref == MAIN_REF:
            raise Refused(ref, MAIN_DELETION_REFUSAL)
        if not ref.startswith(BRANCH_PREFIX):
            raise Refused(ref, f"{ref} cannot be deleted on this hub")
        name = ref[len(BRANCH_PREFIX):]
        if not store.valid_variant(name):
            raise Refused(ref, VARIANT_NAME_REFUSAL)
        # Nothing to build: `run` queues the variant once every ref is
        # accepted, and it is removed after git has deleted the branch.
        return Plan(ref, False, "", None, name, delete=True)
    if ref.startswith(BRANCH_PREFIX):
        draft, name = False, ref[len(BRANCH_PREFIX):]
    elif ref.startswith(DRAFT_PREFIX):
        draft, name = True, ref[len(DRAFT_PREFIX):]
    else:
        return None
    if not store.valid_variant(name):
        raise Refused(ref, VARIANT_NAME_REFUSAL)
    if not draft and old != ZERO and not _is_ancestor(repo, old, new, env):
        raise Refused(ref, "non-fast-forward: pull first")
    try:
        directory = _project_directory(repo, pid, new, ref, env)
        if draft:
            tree = run_git(repo, "rev-parse", f"{new}:{directory}",
                           env=env).strip()
            slot = store.pointer_dir(pid, name, DEV_LINK) / PAYLOAD_DIGEST_FILE
            try:
                in_slot = slot.read_text(encoding="utf-8").strip()
            except OSError:
                in_slot = None
            if tree == in_slot:
                return Plan(ref, draft, directory, None, name, unchanged=True)
            target = new
        else:
            since = [f"^{old}"] if old != ZERO else []
            target = run_git(repo, "rev-list", "--first-parent", "-1", new,
                             *since, "--", directory or ".",
                             env=env).strip() or None
            if target is not None and \
                    store.built_build(pid, target, env) is not None:
                target = None
        if target is not None:
            _refuse_links(repo, target, directory, ref, env)
    except subprocess.CalledProcessError as error:
        raise Refused(ref, git_failure(error)) from error
    return Plan(ref, draft, directory, target, name)


def _is_ancestor(repo, old: str, new: str, env: dict) -> bool:
    try:
        run_git(repo, "merge-base", "--is-ancestor", old, new, env=env)
    except subprocess.CalledProcessError:
        return False
    return True


def _project_directory(repo, pid: str, commit: str, ref: str,
                       env: dict) -> str:
    """Where the project.json with this project's id is in `commit`.

    "" for the root. One and only one, or a refusal naming what was found.
    """
    found = []
    listing = run_git(repo, "ls-tree", "-r", "-z", "--name-only", commit,
                      env=env)
    for path in listing.split("\0"):
        if path != PROJECT_FILE and not path.endswith(f"/{PROJECT_FILE}"):
            continue
        try:
            document = json.loads(run_git(repo, "cat-file", "-p",
                                          f"{commit}:{path}", env=env))
        except (subprocess.CalledProcessError, ValueError):
            continue
        if isinstance(document, dict) and document.get("id") == pid:
            found.append(path)
    if not found:
        raise Refused(ref, f"no {PROJECT_FILE} with id {pid} in {ref}")
    if len(found) > 1:
        raise Refused(ref, f"more than one {PROJECT_FILE} with id {pid} in "
                           f"{ref}: {', '.join(found)}")
    return found[0][:-len(PROJECT_FILE)].rstrip("/")


def _refuse_links(repo, target: str, directory: str, ref: str,
                  env: dict) -> None:
    """Refuse a project directory holding a symlink or a submodule, naming them."""
    listing = run_git(repo, "ls-tree", "-r", "-z", f"{target}:{directory}",
                      env=env)
    links = []
    for entry in listing.split("\0"):
        head, _, path = entry.partition("\t")
        if head.split(" ")[0] in LINK_MODES:
            links.append(f"{directory}/{path}" if directory else path)
    if links:
        raise Refused(ref, f"a symlink or a submodule cannot be published: "
                           f"{', '.join(links)}")


def revision_message(subject: str) -> str | None:
    """A commit's subject as a revision's message, or None for none.

    Cleaned rather than refused: the message is in git already, and the hub
    only shows it. What the rule for a part name refuses goes — non-printable
    characters and angle brackets (`render._check_part_name`) — and the rest is
    cut to `render.MAX_TEXT`.
    """
    kept = "".join(char for char in subject
                   if first_nonprintable(char) is None and char not in "<>")
    return kept.strip()[:render.MAX_TEXT].strip() or None


def _reuse_draft(store: Store, jobs, repo, pid: str, env: dict, plan: Plan,
                 force: bool, say) -> bool:
    """Publish a branch's target from its variant's draft slot. -> whether it did.

    When the slot holds the target's tree, the draft has built and checked it
    already: the revision is the slot's build with the draft's log, and
    nothing is built (`Store.promote_dev`, which also says when it declines).
    Raises Refused.
    """
    try:
        digest = run_git(repo, "rev-parse", f"{plan.target}:{plan.directory}",
                         env=env).strip()
        message = revision_message(run_git(
            repo, "log", "-1", "--format=%s", plan.target, env=env))
    except subprocess.CalledProcessError as error:
        raise Refused(plan.ref, git_failure(error)) from error

    def draft_log(job_id):
        # "" is a job with no log yet. What is there was capped when the job
        # wrote it (`JobStore._write_log`), so it is copied as it is.
        log = jobs.log(job_id)
        return log.encode("utf-8") if log else None

    try:
        answer = store.promote_dev(pid, plan.variant, plan.target, digest,
                                   message, force, draft_log)
    except PublishError as error:
        raise Refused(plan.ref, error.message) from error
    if answer is None:
        return False
    say(f"reused the draft build of this tree for {plan.ref}: not built again")
    say(f"published: {answer[1]['url']}")
    return True


def _build(store: Store, jobs, builds, repo, pid: str, env: dict, plan: Plan,
           force: bool, say) -> str:
    """Build and publish one ref's target, printing its log. -> the address
    it was published at. Raises Refused."""
    tree_ish = f"{plan.target}:{plan.directory}"
    sources = store.root / f"{SOURCE_PREFIX}{uuid.uuid4().hex}"
    index = store.root / f"{JSON_TMP_PREFIX}index-{uuid.uuid4().hex}"
    handed_over = False
    try:
        try:
            sources.mkdir()
            checkout = dict(env, GIT_INDEX_FILE=str(index))
            run_git(repo, "read-tree", tree_ish, env=checkout)
            run_git(repo, "checkout-index", "-a", work_tree=sources,
                    env=checkout, cwd=sources)
            digest = run_git(repo, "rev-parse", tree_ish, env=env).strip()
            message = None if plan.draft else revision_message(run_git(
                repo, "log", "-1", "--format=%s", plan.target, env=env))
        except subprocess.CalledProcessError as error:
            raise Refused(plan.ref, git_failure(error)) from error
        say(f"building {plan.target[:12]} for {plan.ref}")
        name = DEV_LINK if plan.draft else plan.target
        job_id = jobs.create(pid, name)["id"]
        try:
            outcome = builds.submit(BuildTask(
                job_id=job_id, pid=pid, commit=name, sources=sources,
                digest=digest, force=force, message=message,
                variant=plan.variant))
        except Exception:
            jobs.finish(job_id, state=STATE_FAILED, code=500,
                        error=HANDOVER_ERROR)
            raise
        if outcome == SUBMIT_QUEUE_FULL:
            jobs.finish(job_id, state=STATE_FAILED, code=503,
                        error=QUEUE_FULL_ERROR)
            raise Refused(plan.ref,
                          f"hub is busy: {builds.queued()} builds queued")
        if outcome != SUBMIT_ACCEPTED:
            raise Refused(plan.ref, "the hub is stopping; push again")
        handed_over = True
    finally:
        try:
            index.unlink()
        except OSError:
            pass
        if not handed_over:
            shutil.rmtree(sources, ignore_errors=True)

    record = jobs.get(job_id)
    while record["state"] not in (STATE_DONE, STATE_FAILED):
        time.sleep(POLL_SECONDS)
        record = jobs.get(job_id)
    for line in (jobs.log(job_id) or "").splitlines():
        say(line)
    # Before the verdict, so a failed build says its duration too.
    _say_duration(record, say)
    if record["state"] != STATE_DONE:
        raise Refused(plan.ref, record.get("error") or "the build failed")
    say(f"published: {record['build_url']}")
    return record["build_url"]


def commit_name(store: Store, jobs, builds, pid: str, variant: str, kind: str,
                item: str | None, name: str) -> tuple:
    """Commit a name changed on the page into project.json at the tip of
    `variant`'s branch, publish that commit as a revision of the variant, and
    move the branch onto it. -> (200, the answer) or (status, the refusal).

    One key changes (`_rename`), and the rest of the file stays as it was,
    written as the client writes it (`hammerola.project.write_project_title`).
    The commit is made with git's plumbing from a temporary index, so no work
    tree is involved. It is published as a copy of a build of the tip's
    project with the name rewritten (`_publish_renamed`): the model is not
    built for a name. That build is the tip's own, or else the variant's
    `latest` when its sources are the tip's project directory to the byte
    (`_same_tree_build`) — a tip that did not touch the project, such as an
    empty commit. Only a tip whose project tree neither of the two holds is
    built, in the ordinary queue as a pushed branch is (`_build`). The branch moves only
    after the revision is published, and only from the tip the commit was
    made on: a push that moved it meanwhile wins, and the rename is refused
    with 409. `latest` then follows the branch as at the end of a push
    (`githttp.end_of_request`).
    """
    repo = store.repo_dir(pid)
    ref = f"{BRANCH_PREFIX}{variant}"
    try:
        tip = run_git(repo, "rev-parse", "--verify", "--quiet",
                      f"{ref}^{{commit}}").strip()
    except subprocess.CalledProcessError:
        return 404, f"no variant {variant}"
    index = store.root / f"{JSON_TMP_PREFIX}index-{uuid.uuid4().hex}"
    try:
        directory = _project_directory(repo, pid, tip, ref, {})
        path = f"{directory}/{PROJECT_FILE}" if directory else PROJECT_FILE
        project = json.loads(run_git(repo, "cat-file", "-p", f"{tip}:{path}"))
        subject = _rename(store, pid, variant, project, kind, item, name)
        blob = run_git(repo, "hash-object", "-w", "--stdin", input=json.dumps(
            project, indent=1, ensure_ascii=False) + "\n").strip()
        staged = {"GIT_INDEX_FILE": str(index)}
        run_git(repo, "read-tree", tip, env=staged)
        run_git(repo, "update-index", "--cacheinfo",
                f"100644,{blob},{path}", env=staged)
        tree = run_git(repo, "write-tree", env=staged).strip()
        commit = run_git(repo, "commit-tree", tree, "-p", tip, "-m", subject,
                         env=HUB_IDENTITY).strip()
        source = (store.built_build(pid, tip)
                  or _same_tree_build(store, repo, pid, variant, tip,
                                      directory))
        if source is None:
            url = _build(store, jobs, builds, repo, pid, {},
                         Plan(ref, False, directory, commit, variant), False,
                         lambda line: None)
        else:
            url = _publish_renamed(store, repo, pid, variant, source, commit,
                                   directory, project, kind, item, name,
                                   subject)
    except NotThere as error:
        return 404, str(error)
    except PublishError as error:
        logger.warning(f"rename {pid} {variant}: refused: {error.message}")
        return error.status, error.message
    except Refused as refusal:
        logger.warning(f"rename {pid} {variant}: refused: {refusal}")
        return 422, str(refusal)
    except subprocess.CalledProcessError as error:
        return 500, git_failure(error)
    finally:
        index.unlink(missing_ok=True)
    try:
        run_git(repo, "update-ref", ref, commit, tip)
    except subprocess.CalledProcessError:
        return 409, "the branch moved while renaming; rename again"
    logger.info(f"rename {pid} {variant}: {subject}: {commit}")
    try:
        store.recompute(pid)
    except Exception:
        logger.exception(f"rename {pid} {variant}: the project could not be "
                         f"brought up to date after the rename")
    return 200, {"commit": commit, "build_url": url}


def _same_tree_build(store: Store, repo, pid: str, variant: str, tip: str,
                     directory: str) -> str | None:
    """The variant's `latest`, when its payload digest is the git id of the
    tip's project directory: the same sources, built. None otherwise. A
    build published before git carries the digest of its archive, never a
    tree's id, so it is never taken for one."""
    latest = store.latest_commit(pid, variant)
    if latest is None:
        return None
    try:
        built = (store.build_dir(pid, latest) / PAYLOAD_DIGEST_FILE).read_text(
            encoding="utf-8").strip()
    except OSError:
        return None
    tree = run_git(repo, "rev-parse", f"{tip}:{directory}").strip()
    return latest if built == tree else None


def _publish_renamed(store: Store, repo, pid: str, variant: str, source: str,
                     commit: str, directory: str, project: dict, kind: str,
                     item: str | None, name: str, subject: str) -> str:
    """Publish the rename `commit` as a copy of `source`, a build of the
    project tree of the tip it was made on — the tip's own, or the variant's
    `latest` (`_same_tree_build`) — through `Store.publish_copy`. -> the
    address it was published at.

    The copy's meta.json is `source`'s with what the commit changed: its own
    `commit`, `message`, branch and arrival, and the name — `title` with
    `project` as a build derives both from the new project.json
    (`docsbuild.project_names`), `variant_label`, or the `name` of the view or
    the document. `published` is the copy's own, so the picker orders it after
    `source`, whose `built` it keeps. The payload digest is the commit's
    project directory, as a pushed revision's is (`_build`).
    """
    meta = json.loads(store.build_meta_path(pid, source).read_text(
        encoding="utf-8"))
    meta.update(commit=commit, variant=variant, published=published_stamp())
    meta.pop("message", None)
    message = revision_message(subject)
    if message:
        meta["message"] = message
    if kind == "project":
        meta["project"], meta["title"] = project_names(project, pid)
    elif kind == "variant":
        meta["variant_label"] = name
    else:
        for entry in meta.get("views" if kind == "view" else "documents", ()):
            if entry.get("id") == item:
                entry["name"] = name
    digest = run_git(repo, "rev-parse", f"{commit}:{directory}").strip()
    return store.publish_copy(pid, source, commit, meta, digest, variant)[1]["url"]


def _rename(store: Store, pid: str, variant: str, project: dict, kind: str,
            item: str | None, name: str) -> str:
    """Write `name` into `project`, the parsed project.json, at the key `kind`
    names. -> the commit's subject. Raises NotThere for a view or a document
    the variant does not have."""
    if kind == "project":
        project["title"] = name
        return f'Rename the project to "{name}"'
    if kind == "variant":
        project["variant"] = name
        return f'Rename the variant to "{name}"'
    if kind == "view":
        if not _declares_view(store, pid, variant, item):
            raise NotThere(f"no view {item} in {variant}")
        if not isinstance(project.get(VIEWS_FIELD), dict):
            project[VIEWS_FIELD] = {}
        project[VIEWS_FIELD][item] = name
        return f'Rename the view "{item}" to "{name}"'
    documents = project.get(DOCUMENTS_FIELD)
    for at, entry in enumerate(documents if isinstance(documents, list) else ()):
        path = entry.get("file") if isinstance(entry, dict) else entry
        if isinstance(path, str) and render.document_id(path) == item:
            if isinstance(entry, dict):
                entry["title"] = name
            else:
                documents[at] = {"file": path, "title": name}
            return f'Rename the document "{path}" to "{name}"'
    raise NotThere(f"no document {item} in {variant}")


def _declares_view(store: Store, pid: str, variant: str, view_id: str) -> bool:
    """Does the variant's `latest` have this view? Any id a view may have,
    while the variant has no build to ask."""
    latest = store.latest_commit(pid, variant)
    try:
        meta = json.loads(store.build_meta_path(pid, latest).read_text(
            encoding="utf-8")) if latest else None
    except (OSError, ValueError):
        meta = None
    if meta is None:
        return store.valid_view_id(view_id)
    return any(view.get("id") == view_id for view in meta.get("views", ()))


def _say_duration(record: dict, say) -> None:
    """How long this build took, and a word when that is long enough to matter.

    The build time is the job's `duration_seconds`, measured on a monotonic
    clock; it is never computed from the wall-clock stamps, which can jump. The
    queue wait is the gap between two wall-clock stamps. A ref answered
    `unchanged` has no job and says neither.
    """
    duration = record.get("duration_seconds")
    # `is None`, not falsiness: a build can measure zero seconds. The record
    # holds a finite number or None (`jobs._number`).
    if duration is None:
        return
    seconds = int(round(duration))
    waited = _queue_wait(record)
    bracket = f" (queued {_clock(waited)})" if waited is not None else ""
    say(f"built in {_clock(seconds)}{bracket}")
    if (seconds > SLOW_BUILD_SECONDS
            and record.get("status") not in SELF_DIAGNOSING):
        # A warning, not a refusal: a slow build publishes. Both numbers use the
        # same format so they compare by eye.
        warning = SLOW_BUILD_WARNING.format(took=_clock(seconds),
                                            limit=_clock(SLOW_BUILD_SECONDS))
        for line in warning.splitlines():
            say(line)


def _queue_wait(record: dict) -> int | None:
    """Seconds spent waiting for a worker, or None when there is nothing to say.

    None in all three cases where the bracket would be a lie or a distraction:
    a job that never started (no stamp), a difference that came out NEGATIVE
    (the stamps are wall-clock and can jump backwards), and a wait under a
    second, which is the ordinary case on an idle hub and says nothing.

    The stamps carry whole seconds, so the difference is a whole number and
    nothing here rounds.
    """
    try:
        created = datetime.strptime(record.get("created"), STAMP)
        started = datetime.strptime(record.get("started"), STAMP)
    except (TypeError, ValueError):
        return None
    waited = int((started - created).total_seconds())
    return waited if waited >= 1 else None


def _clock(seconds: int) -> str:
    """Whole seconds as `8s`, `4m12s`, `1h02m03s`.

    Zero-padded past the first field so two durations line up by eye.
    """
    hours, rest = divmod(seconds, 3600)
    minutes, whole = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{whole:02d}s"
    if minutes:
        return f"{minutes}m{whole:02d}s"
    return f"{whole}s"
