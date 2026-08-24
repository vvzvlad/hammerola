# hammerola

Builds CAD models from code and serves them through a browser viewer. The name is from
"pianola" — a mechanism that plays itself: push a model source, get back a page you can
open, rotate and download printable files from.

**Status: scaffold.** This repository is the skeleton only — `src/` holds nothing but the
settings entry point. The service is being assembled out of three existing repositories
(`cad_snapshot_hub`, `3d/cad_builder`, `3d/cad_publish`), step by step. What is being built
and in what order is in `docs/SPEC.md`, section 8A; `AGENTS.md` carries the checklist.

The layout below follows the «Как создавать проект» guide in the gitmost wiki
(space Netmap, section «Руководства»).

## Quick start

Everything routine is wrapped in the `Makefile` (`make help` lists all targets):

```bash
make install                # create .venv + install dev/test deps
cp .env.example .env        # fill in the values
make test                   # run tests
make run                    # run the app
```

Python targets (`make test`, `make run`) create and reuse a local `.venv`
automatically — you never need the system Python.

## Git remotes

Name the remotes explicitly when you create the repository, before the first push:

```bash
git remote add origin https://gitea.vvzvlad.xyz/projects/<repo>.git
git remote add github https://github.com/vvzvlad/<repo>.git   # only if a mirror exists
```

`origin` is Gitea because Gitea is the canonical forge, and a bare `git push` goes to
`origin`. GitHub, when it exists at all, is a **push-mirror** driven from Gitea: it
force-updates the remote side, so anything pushed straight to GitHub survives only until
the next sync. That is not hypothetical — four commits in `glazy_solver` were pushed to
GitHub and wiped by the mirror on 09.08.2026, and had to be recovered from a local clone.
Naming Gitea `origin` is what makes the reflex-level `git push` land where it belongs.

Do not name a remote after a branch. `smarthome_floorplan` had its only remote called
`main`, so `git push main main` read as a branch-to-branch push and every command about
remotes needed a second look.

## One name, everywhere

The repository, the working directory, the compose service, the `container_name`, the
Portainer stack and the published image all carry the **same** name, written with
underscores:

```text
repo         proxmox_dns
directory    ~/Data/Projects/proxmox_dns
service      proxmox_dns          # in docker-compose.yml
container    proxmox_dns          # container_name
stack        proxmox_dns          # in Portainer
image        gitea.vvzvlad.xyz/projects/proxmox_dns
```

Each of those names is somebody's lookup key: `docker ps` and `docker logs` take the
container name, Portainer lists the stack, the registry path is the repo name, and anyone
(human or agent) asked about "the X service" greps for a single string. When the names
disagree, every lookup silently needs a translation table that lives only in someone's
head — each name still resolves on its own, so nothing ever errors.

This is a real state of this fleet, not a hypothetical: `proxmox_dns` shipped as repo
`proxmox_dns`, directory `proxdns`, container `proxdns`, stack `proxmox-dns` and image
`proxmox_dns` — four spellings of one service, so `docker ps | grep proxmox_dns` came back
empty on the very host running it.

Underscores rather than hyphens because the name must also be a legal Python
package/module name; otherwise the repo name and the import name diverge as soon as
anything is imported. The one exception is a DNS name (`proxdns.borneo.lc`) — that is a
separate, externally visible identifier, it may be shorter, and renaming it breaks links.

## What's here

| Path | Purpose |
|------|---------|
| `Makefile` | Single entry point for repeated actions: `install`, `test`, `run`. Run `make help`. |
| `src/` | Application code; `settings.py` reads all config from ENV / `.env`. |
| `tests/` | pytest suite (runs in CI before the image is built). |
| `ci/smoke.py` | The gate between build and publish. Drives `docker` against the freshly built image and checks the things a green test suite cannot: the declared ENTRYPOINT/CMD/WORKDIR, that the startup guard still fires *and still names the missing variable*, that privileges are really dropped to `app`, that `.dockerignore` kept `tests/`, `.env` and `.venv` out of the image, and that the image's own command reaches its startup marker. No ports, no secrets, no network — so the identical gate runs on pull requests too. |
| `data/` | Runtime state (SQLite, cache, files). Gitignored, mounted as a volume. |
| `templates/` | Static assets baked into the image. |
| `Dockerfile` | Slim single-stage build; deps cached before code; no `EXPOSE`; no `USER` — privileges are dropped by `entrypoint.sh`. |
| `entrypoint.sh` | Postgres-style hybrid: starts as root, fixes `/app/data` ownership, drops to non-root `app` (uid 1000) via gosu. |
| `docker-compose.yml` | Deploy template — image from the Gitea registry, volume, Traefik labels, and **one** auto-update label (`io.portainer.update.enable`), read by the ContainerAutomation auto-update in **our** Portainer build (the fork in the Gitea repository `projects/portainer` on `gitea.vvzvlad.xyz`, not a directory in this repo; upstream Portainer, CE or BE, has no such mechanism). Do not add the watchtower-family key beside it — unconditionally: no watchtower is left anywhere in this fleet, so a second key is dead text that still reads like a working fallback. Separately: the polling, the health gate and the rollback are a property of the control plane that owns the target host, so check that ownership before relying on the label. The volume KEY is not the volume NAME (`<stack>_<key>`): the name this file computes must match the volume already on the host, and a different stack name **or** a different key spelling silently mounts a new empty volume and comes up looking healthy with all state gone — check `docker volume ls` on the target host first, or pin it with `external: true` + `name:`. Config goes in `environment:` or a file committed beside this one — never an absolute host path in `env_file:`, which Portainer resolves inside its OWN container, not on the target host. |
| `.env.example` | Full list of env vars with placeholders. Copy to `.env`. |
| `.gitea/workflows/image-check-publish.yml` | Gitea Actions CI on push to `main`/`develop`: `test` → compute tags → `build` → **smoke gate** → `docker login` → push to `gitea.vvzvlad.xyz` (`main` → `:latest` + `:<sha>`; any other branch → `:<branch>` only) → cleanup. The login sits *after* the gate on purpose: until it is green there is nothing to publish, so the registry PAT never exists on the runner while untrusted build steps are running. Deliberately not triggered on `pull_request` — a PR build would push `:latest` and auto-update would deploy it. |
| `.gitea/workflows/tests.yml` | Pull requests into `main`/`develop`: the same suite in the same container, an image built from the same Dockerfile with the same build flags — the publishing workflow applies the registry tags, this one a single local tag it never pushes — and the byte-identical smoke gate against it, then it stops. No login, no credentials, nothing published. A separate workflow exactly because the publishing one must stay off PRs; without it a broken test *or a broken image* would only surface after the merge. |
| `AGENTS.md` | Conventions / onboarding for agents. |
| Guide (in the wiki) | The full "how to create a project" guide — «Как создавать проект» in the gitmost wiki (space Netmap / «Инфра»). |

## CI in one breath

Both workflows run the suite inside a `python:3.11-slim` container started by the same
docker the build uses — no `actions/setup-python`, because a setup action that quietly
fails on this runner produces a job that passes having checked nothing. The workspace
reaches that container as a **tar over stdin**, not a bind mount: the job itself runs
inside a container while `docker` drives the host's daemon, so `-v "$PWD:/src"` would
resolve on the host and mean something else entirely. The same split is why `ci/smoke.py`
publishes no ports and reads everything it needs through `docker exec`.

## Rules in one breath

All mutable state in `data/`; all config and credentials from ENV / `.env` (never
in code, never defaulted); tests are mandatory and gate the Docker build; a smoke gate
stands between the build and the registry, so an image that cannot start, runs as root,
or carries a baked-in `.env` never gets published; deploy a prebuilt image from the Gitea
registry via docker-compose behind Traefik; code comments and the user-facing interface
(UI text, CLI output, log lines) are in English unless the task asks for another language.
See the guide for the full rationale.
