# Agent Instructions — hammerola

`hammerola` собирает CAD-модели из кода (CadQuery) и раздаёт их браузерным
вьювером. `src/` — сервис-хаб, `src/cadbuild/` — сборочная половина,
`src/buildproc/` — отдельный сборочный процесс с rlimit-ами, `hammerola/` —
клиент (stdlib only), которым автор публикуется, `ui/` — браузерный бандл,
`viewer/` — наш форк three-cad-viewer, `ci/smoke.py` — гейт образа.

Обоснования лежат в `docs/` и читаются по ссылке; сюда их не переносить.

## Прежде чем писать код

1. **`docs/SPEC.md`, начиная с раздела 8A** — план работ. Врезка в начале файла
   объясняет, что актуально. Разделы 1–7 — проверенные факты и подводные камни.
2. **`docs/repo-map.md`** — что где лежит и почему. Незнакомый файл ищи там.
3. **`docs/conventions.md`** — правила проекта с обоснованиями.
4. Скилл `new-project` и гайд «Как создавать проект» (вики `gitmost-vvzvlad`,
   пространство Netmap, раздел «Руководства», pageId
   `019f526f-7dbe-7f2f-9181-a26737034628`) — раскладка, Dockerfile, non-root
   entrypoint, CI на Gitea, деплой. **Netmap — источник правды по хостам.**

Беклог — задачи `projects/hammerola` на `gitea.vvzvlad.xyz`.

## Решения, которые не переоткрывают

Разбор — в SPEC 8A.

- **Зависимости модели — только из образа.** Ничего не ставится по запросу модели.
- **Комментарии — заметка агенту, а не публичный канал:** запись только под токеном.
- **`keep_instances` не берём** — он ломает пофайловое сравнение по байтам буфера.
- **`model.py` — код владельца, а не недоверенный ввод.** Отдельный сборочный
  процесс (`src/buildproc/`) — граница против ОШИБКИ модели. Второй барьер внутри
  процесса не нужен: прежде чем добавлять защиту, проверь, не выдуман ли противник.
- **VTK принимаем как есть** — его жёстко требует сам `cadquery-ocp`.
- **`static/_v/three-cad-viewer.*` — НАШ выход из `viewer/`:** правишь
  `viewer/src/` → `make viewer` → коммитишь исходник и сборку одним коммитом.
  `three.module.js` и `three.core.js` — npm-овские, копируются без изменений
  (three вынесен из бандла). Импорт-карты нет: CSP хаба режет инлайновый скрипт.
- **Чего не делать никогда** (SPEC 8A.4): docker-сокет в любом виде,
  docker-in-docker и `privileged`, `exec()` модели в процессе хаба,
  RestrictedPython и любой in-process барьер, nsjail/bubblewrap внутри Docker,
  `userns-remap`.
- **Один секрет на всю систему — `EDIT_TOKEN`.** Им публикуются и им же стирают
  проект целиком. Ретенции нет ни у сборок, ни у задач.

## Setup, тесты, запуск

Все рутинные действия — через `Makefile` (`make help`).
```bash
make install           # create .venv and install dev/test deps
make env               # create .env from .env.example, then fill in the values
make test              # pytest, plus the JS suite when npm is present
make cad-test          # the six tests that need the CAD kernel
make run               # runs .venv/bin/python main.py
make ui                # build the browser bundle into static/_v/ (needs npm)
make lock              # regenerate requirements.lock (slow, deliberate)
```

На ноутбуке тесты не гоняются — их гоняет CI. CI (`.gitea/workflows/tests.yml` на
PR, `image-check-publish.yml` на push в `main`/`develop`) запускает весь набор в
образе из `ci/Dockerfile.test` (с библиотеками CAD-ядра) параллельно,
`pytest -n 4 --dist loadfile`, плюс vitest в node-контейнере. `make test`
последовательный: тест, падающий только параллельно, воспроизводи строками
`TEST_IMAGE=`, `docker build` и `docker run` из шага тестов.

## Деплой

`image-check-publish.yml`: тесты → `docker build` → гейт `ci/smoke.py` → push в
`gitea.vvzvlad.xyz/projects/hammerola` (`main` → `:latest` + `:<sha>`, другие
ветки → `:<branch>`). Прод — стек Portainer с авто-обновлением по лейблу
`io.portainer.update.enable`; `docker-compose.yml` — только пример.

## Git remotes

`origin` — Gitea (`https://gitea.vvzvlad.xyz/projects/<repo>.git`); GitHub, если
зеркало есть, — второй remote `github` (push-mirror перетирает прямые пуши туда).
Не называй remote именем ветки.

## Conventions

Полный список с обоснованиями — `docs/conventions.md`; читай его, прежде чем
нарушать или «упрощать» правило.

- Commit messages, code comments and user-facing text (UI, CLI, logs) are in
  English. Commits: conventional-commit subject, body explaining WHY.
- All mutable state goes under `data/`. All config comes from ENV / `.env`;
  missing ENV var → fail at startup, no default credentials in code.
- Python always runs inside the local `.venv`, invoked as `$(PY) -m pip` /
  `-m pytest` — never `.venv/bin/pip` or `.venv/bin/pytest`.
- Tests are required for new code; in CI `build` depends on `test`.
- An assertion that has to stay true belongs in a TEST, not in a comment: "keep X
  and Y in step" is the specification for a test.
- Module-level mutable state (singleton, cache, registry) gets an autouse fixture
  asserting it is clean BOTH before and after each test.
- `hammerola/` imports the standard library only (`tests/client/test_stdlib_only.py`).

Ломается молча — прогон этого не покажет:

- Between building the image and publishing it there is a GATE — `ci/smoke.py`,
  its own step in both workflows. Add new checks THERE. It counts its own
  verdicts: update the declared count deliberately, never to match a run.
- Exactly six `run:` bodies are BYTE-IDENTICAL between the two workflows and move
  in lockstep; `tests/test_workflow_steps.py` hashes them. The BUILD step and the
  IMAGE-cleanup step deliberately differ — do not "fix" them.
- Every container CI starts is `--name`d, and EVERY removal carries `-v` — in both
  workflows and in `remove_container()` in `ci/smoke.py`.
- The healthcheck's timings are part of the deploy mechanism, `start_period`
  included. Dropping the healthcheck disables the rollback gate rather than
  passing it.
- A compose volume KEY is not the volume NAME (`<stack>_<key>`); a mismatch
  silently creates a new empty volume and the stack comes up looking healthy.

## Limits for agents
- Tests: at most three times the code (`wc -l` of `tests/` against the code). Over the limit,
  still write the test you need, and in the same change go through the old tests: drop or merge
  duplicates and tests of implementation rather than behaviour.
- Comments explain the code as it is and why it is built this way. History ("used to", "after
  the review", "since the incident") goes into the commit message.
- This file stays under ~150 lines: only what an agent would get wrong without it. No decision
  history, incident logs or retelling of the code.

## FPF

Паттерн читай через MCP `fpf` (`read_pattern <ID>`) до того, как применять.

- Ревизия названа дайджестом исходников (`Store.mint_revision`, SPEC §7.7), а байты сборки зависят ещё от образа (пины `cadquery` и `cadquery-ocp`) — SYSE.30 «Make Software Builds Repeatable and Traceable»: при «тот же код — другие байты» восстановить все входы сборки, включая образ, и не считать имя ревизии полной идентичностью сборки.
- Публикация, переключение `latest` и раздача сборок под годовым кэшем; образ хаба между `ci/smoke.py` и push — SYSE.32 «Promote Verified Artifacts without Rebuilding»: дальше идёт ровно тот объект, что прошёл проверку (`.payload.sha256`, тот же образ), без пересборки и без подмены под тем же адресом.
