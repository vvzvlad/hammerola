# Agent Instructions — hammerola

`hammerola` (от «пианола» — механизм, который играет сам) собирает CAD-модели из
кода и раздаёт их браузерным вьювером. `src/` — сервис, `src/cadbuild/` —
сборочная половина, `hammerola/` — клиент, которым автор публикуется.

**Этот файл — короткий: он грузится в КАЖДЫЙ контекст, включая свежий после
компакта, и в каждый воктри отдельной копией.** Здесь только то, что нельзя
нарушить, не открыв ничего; обоснования лежат в `docs/` и читаются по ссылке.
Не возвращай их сюда — 2026-09-09 файл на 84 КБ грузился по три раза за круг и
съедал 55k токенов из окна, чем и загонял сессию в петлю автокомпакта.

## Прежде чем писать код

1. **`docs/SPEC.md`, начиная с раздела 8A** — план работ. Врезка в начале файла
   объясняет, что актуально, а что описывает состояние ДО переезда. Разделы 1–7 —
   проверенные эмпирически факты и подводные камни; перепроверять их не надо.
2. **`docs/bootstrap.md`** — состояние переезда. Восемь шагов из девяти закрыты,
   открыт ровно один: **шаг 8 «Сравнение ревизий»** (issue #10). Пока чеклист не
   закрыт, не считай проект готовым, даже если код формально работает.
3. **`docs/repo-map.md`** — что где лежит и почему. Прежде чем трогать файл,
   которого не знаешь, найди его там: почти у каждого каталога есть причина быть
   именно таким, и она записана.
4. **`docs/conventions.md`** — обоснования правил из списка ниже.
5. Скилл `new-project` и гайд «Как создавать проект» (вики `gitmost-vvzvlad`,
   пространство Netmap, раздел «Руководства», pageId
   `019f526f-7dbe-7f2f-9181-a26737034628`) — раскладка, settings, Dockerfile,
   non-root entrypoint, CI на Gitea, деплой. **Netmap — источник правды по хостам.**

Беклога здесь нет: он живёт задачами `projects/hammerola` на `gitea.vvzvlad.xyz`.

## Решения, которые не переоткрывают

Каждое стоило отдельной работы; разбор — в `docs/bootstrap.md` и SPEC 8A.

- **Зависимости модели — только из образа.** Ничего не ставится по запросу модели.
- **Комментарии — заметка агенту, а не публичный канал:** запись только под токеном.
- **`keep_instances` не берём** — он ломает пофайловое сравнение по байтам буфера.
- **`model.py` — код владельца, а не недоверенный ввод.** Противника в этой системе
  нет. Отдельный сборочный процесс (`src/buildproc/`) — граница против ОШИБКИ
  модели, и она настоящая. ВТОРАЯ граница, из проверок типов внутри того же
  процесса, была выдумана и стоила 23 кругов ревью. Критерий на будущее — не
  «работает ли эта защита», а «не выдумал ли я противника».
- **VTK принимаем как есть** — его жёстко требует сам `cadquery-ocp`.
- **Чего не делать никогда** (SPEC 8A.4): docker-сокет в любом виде,
  docker-in-docker и `privileged`, `exec()` модели в процессе хаба,
  RestrictedPython и любой in-process барьер, nsjail/bubblewrap внутри Docker,
  `userns-remap`. Каждый пункт проверен по источникам.
- **Один секрет на всю систему — `EDIT_TOKEN`.** Им же публикуются, им же стирают
  проект целиком. Ретенции нет ни у сборок, ни у задач.

## Setup
All routine actions go through the `Makefile` — run `make help` to list targets.
```bash
make install           # create .venv and install dev/test deps
cp .env.example .env   # then fill in the values  (shortcut: make env)
```

## Running tests
```bash
make test              # runs .venv/bin/python -m pytest
make cad-test          # the five tests that need the CAD kernel
```

CI computes no real geometry: `libgl1` is deliberately not in the test container
(issue #27), so those five skip there. **Touching `src/cadbuild/` means running
`make cad-test` on a machine where the kernel imports** — nothing else notices when
the payload's shape drifts away from `ui/tests/fixtures/assembled.json`.

## Running the app
```bash
make run               # runs .venv/bin/python main.py
```

## Git remotes
`origin` points at Gitea (`https://gitea.vvzvlad.xyz/projects/<repo>.git`), and GitHub —
when the repo has a mirror at all — is a second remote named `github`. Set both up before
the first push. Gitea is the canonical forge and GitHub is a push-mirror that force-updates
the remote side, so a push straight to GitHub lives only until the next sync; naming Gitea
`origin` is what keeps a plain `git push` from ending up there. Never name a remote after a
branch (`main`, `develop`) — it makes every `git push <remote> <branch>` ambiguous to read.

## Conventions

Правила целиком, без обоснований — **почему** каждое из них такое, читай в
`docs/conventions.md`, и читай до того, как соберёшься одно из них нарушить или
«упростить»: почти каждое записано после того, как сломалось молча.

- One name for the project everywhere — repo, directory, compose service,
  `container_name`, stack, image — spelled with underscores. `docs/conventions.md`.
- Commit messages are written in English: conventional-commit subject, body
  explaining WHY. Code comments are in English. The user-facing interface
  (UI text, CLI output, logs) is in English too.
- All mutable state goes under `data/`. All config comes from ENV / `.env`.
- Credentials and addresses of our own services go ONLY into `.env`, read through
  `Settings`; no default/example credentials in code; missing ENV var → fail at
  startup. A default address is allowed ONLY for public third-party APIs.
- In compose, configuration lives in the service's own `environment:` or in a file
  that TRAVELS with the stack — never an absolute host path in `env_file:`.
- All repeated actions go through `make` targets. Python always runs inside the
  local `.venv`, invoked as `$(VENV)/bin/python -m pip` / `-m pytest` — never
  `.venv/bin/pip` or `.venv/bin/pytest`.
- Tests are required for new code; in CI `build` depends on `test`.
- **An assertion about how the code behaves, which has to stay true, belongs in a
  TEST rather than in a comment or a document.** When you catch yourself writing
  "keep X and Y in step", that sentence is the specification for a test.
- Runtime dependencies are pinned with `==`, and a dependency the code imports
  DIRECTLY is named in `requirements.txt` even when it arrives through an extra.
  Comment a requirement with what BREAKS without it.
- Module-level mutable state (singleton, cache, registry) gets an autouse fixture
  asserting it is clean BOTH before and after each test.
- Between building the image and publishing it there is a GATE — `ci/smoke.py`,
  its own step in both workflows. Add new checks THERE. It counts its own
  verdicts: update the declared count deliberately, never to match a run.
- `docker login` runs AFTER the gate, and the `docker logout` under `if: always()`
  stays. Do not reorder those steps.
- Exactly six `run:` bodies are BYTE-IDENTICAL between the two workflows and move
  in lockstep; `tests/test_workflow_steps.py` hashes them. The BUILD step and the
  IMAGE-cleanup step deliberately differ — do not "fix" them.
- Every container CI starts is `--name`d, and EVERY removal carries `-v` — in both
  workflows and in `remove_container()` in `ci/smoke.py`.
- CI installs no Python on the runner: pytest runs inside `python:3.11-slim` with
  the workspace streamed in as a tar. No `actions/setup-python`, no bind mount.
- `ci/smoke.py` publishes no ports and never talks to `127.0.0.1` — observe
  containers through `docker exec`.
- `concurrency:` serialises a branch's runs but does NOT guarantee an image per
  commit, and it requires Gitea >= 1.26 — an older instance ignores it silently.
- No `EXPOSE` in the Dockerfile — Traefik publishes via compose labels.
- The container runs as non-root `app` (uid 1000): the entrypoint drops privileges
  with gosu. Do not add a `USER` directive and do not remove the entrypoint.
- One auto-update label, `io.portainer.update.enable`, read by OUR Portainer build.
  Do not add watchtower-family keys. What the label buys is a property of the
  CONTROL PLANE that owns the host — check ownership, do not memorise a host list.
- Do not add `io.portainer.autoheal.enable` without deciding to: it can MASK the
  auto-update's rollback gate.
- The healthcheck's timings are part of the deploy mechanism, `start_period`
  included. Dropping the healthcheck disables the rollback gate rather than
  passing it.
- A compose volume KEY is not the volume NAME (`<stack>_<key>`); a mismatch
  silently creates a new empty volume and the stack comes up looking healthy.
