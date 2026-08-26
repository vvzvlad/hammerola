# Agent Instructions — hammerola

<!-- ======================================================================
     BOOTSTRAP — удали эту секцию целиком, когда её пункты закрыты.
     ====================================================================== -->

## ⚠️ Проект в середине переезда: хаб уже здесь, билдера ещё нет

Код сервиса из `cad_snapshot_hub` уже перенесён — `src/` раздаёт сайт, принимает пуш,
рендерит вьювер и держит очередь комментариев, тесты и шаблоны с ассетами на месте.
Ядро CadQuery уже в образе: пины в `requirements.txt`, системные библиотеки в
Dockerfile, `import cadquery` проверяется гейтом (`ci/smoke.py`, проверка (f)).
Со сборкой хаб уже соединён: с шага 5 пуш принимается асинхронно и модель считается в
отдельном процессе на пути запроса (`src/jobs.py` → `src/buildproc/`). Чего ещё нет —
гейта на приёмной стороне (шаг 6) и снятого CI-обвеса вокруг старой схемы (шаг 7).
Именно поэтому шаги плана начинаются с приёма ДЕРЕВА исходников (шаг 2), а не с нуля.

**Что это за проект.** `hammerola` (от «пианола» — механизм, который играет сам)
собирает CAD-модели из кода и раздаёт их браузерным вьювером. Он ПОГЛОЩАЕТ три
существующих репозитория, и все три остаются на диске как источник кода и решений:

| Репозиторий | Что оттуда берётся |
| --- | --- |
| `/Users/vvzvlad/Data/Projects/cad_snapshot_hub` | раздача снапшотов, вьювер, приём пуша, ретенция, комментарии |
| `/Users/vvzvlad/Data/Projects/3d/cad_builder` | образ с CadQuery — ядро геометрии |
| `/Users/vvzvlad/Data/Projects/3d/cad_publish` | сборка модели, гейт на геометрию, публикация |

**Порядок действий, прежде чем писать код:**

1. **Прочитай `docs/SPEC.md`, начиная с раздела 8A** — это план работ проекта.
   Врезка в начале файла объясняет, что в документе актуально, а что описывает
   состояние ДО переезда. Разделы 1–7 — проверенные эмпирически факты и подводные
   камни; перепроверять их не надо, это уже стоило времени. Раздел 8 — беклог.
2. Прочитай соглашения:
   - скилл `new-project` — процедура создания проекта;
   - гайд **«Как создавать проект»**, вики `gitmost-vvzvlad`, пространство Netmap
     (spaceId `019edbc4-1346-7ea4-8cd8-f89e40f05602`), раздел «Руководства», pageId
     `019f526f-7dbe-7f2f-9181-a26737034628`. Для Python-сервиса в Docker он
     обязателен целиком: раскладка, settings, Dockerfile, non-root entrypoint,
     CI на Gitea, деплой.
   - **Netmap — источник правды по хостам.** Прежде чем что-то делать с
     инфраструктурой, ищи хост там.
3. Закрой чеклист ниже — это ровно девять шагов из SPEC 8A.2.

**Чеклист незакрытого (шаги плана 8A.2):**

- [ ] **Шаг 0. Комментарии под токен.** Публичная запись комментариев переводится
      под токен — это то, что закрывает дорожку от анонимного ввода до исполнения
      кода (SPEC 8A.1).

      Ресурсных лимитов контейнера в этом шаге НЕТ намеренно, хотя в SPEC 8A.2 они
      записаны рядом. Там они относятся к УЖЕ РАБОТАЮЩЕМУ хабу, у которого
      контейнер живёт без единого потолка; здесь код сервиса уже перенесён, но он
      ни разу не выкатывался и геометрию пока не считает — снимать числа попросту
      не с чего, а под сборку моделей их всё равно придётся пересчитывать, когда
      появится что считать. Лимиты ставятся тогда же, когда сервис впервые
      выкатывается, — по замерам, а не наугад.
- [x] **Шаг 1. Ядро в образ.** Пины `cadquery`, `cadquery-ocp`, `ocp-tessellate`,
      `trimesh`; системные библиотеки в Dockerfile (`libgl1`, `libx11-6`, `libexpat1`,
      `libxext6`, `libxrender1`, `libsm6`, `libice6`, и намеренно НЕ `libglu1-mesa`);
      `import cadquery` в smoke внутри собранного образа.
- [ ] **Решить судьбу lock-файла.** Запинены 4 дистрибутива из 60, которые ставит
      `requirements.txt`, ещё три запинены за нас выше по дереву (`vtk`,
      `cadquery-ocp-proxy`, `pydantic-core`); оставшиеся 53 плавают — включая
      `numpy` (формирует те самые буферы), `nlopt` и `casadi` (солвер положения
      деталей в сборках), `numba`, `llvmlite`, `scipy`, `ezdxf`, `matplotlib`. Пины
      держат ядро геометрии, но не сборку целиком, поэтому «тот же исходник — та же
      геометрия» сегодня не гарантировано, а вместе с этим проседает и посылка
      сравнения ревизий из SPEC §8: «одинаковый хеш буфера = деталь не менялась».
      Lock-файл — отдельное решение со своей ценой (пересборка на каждый апдейт,
      ручной bump), поэтому его надо принять явно, а не по умолчанию.
- [x] **Шаг 2. Приём дерева вместо плоского архива** — вместе со второй линией
      обороны от обхода путей: `..`, абсолютные пути, симлинки, потолки на глубину,
      число файлов и распакованный размер. **Сделано.** Имя члена — относительный
      путь, проверяется покомпонентно тем же алфавитом, что раньше проверял всё имя
      целиком; потолки `MAX_PATH_DEPTH = 8`, `MAX_MEMBERS = 1024` (было 256),
      распакованный объём по-прежнему `MAX_BUILD_BYTES`; вторая линия — realpath
      **внутри** staging (по компоненту, а не по префиксу строки), третья — проход по
      одному компоненту через `mkdirat`/`openat` с `O_DIRECTORY|O_NOFOLLOW`, каталоги
      хаб создаёт сам. Обоснования — SPEC §7.1, тесты — `tests/test_archive_security.py`.
- [x] **Шаг 3. Перенос `cad_publish` внутрь** — сделано. Сборочная половина живёт
      в `src/cadbuild/` (19 модулей), её тесты — в `tests/cadbuild/` (9 файлов,
      169 тестов, свой `conftest.py`). Клиентская половина осталась в
      `cad_publish` и НЕ переезжала: `cli`, `__main__`, `settings`, `hub`,
      `remote`, `gitinfo`, `init_project`, `preview` (локальный HTTP-сервер
      предпросмотра — у хаба свой), `archive` (клиент пакует, хаб распаковывает).
      Из `metrics.py` не поехали `fetch_baseline` и `check_project_match` — это
      ноутбук, спрашивающий хаб по HTTP; чистая половина (диффы, отпечатки
      исходника, печать) поехала целиком. `render.py` переименован в
      `preview_png.py`, потому что в хабе уже есть `src/render.py` про другое.
      **Судьба `checklib` решена:** он остался частью контракта с моделью —
      `src/cadbuild/checklib.py` плюс шим `checklib.py` В КОРНЕ репозитория, как
      было в `cad_publish`. Корень, а не пакет: модель импортируется с её
      собственным каталогом первым в `sys.path`, значит имя обязано
      разрешаться на пути ПОЗАДИ него, и этим путём в образе является `/app`.
      Механика обнаружения затенения (`geometry._warn_if_checklib_shadowed`)
      работает как работала. Ничего из перенесённого не подключено к сервису —
      это шаги 4 и 6.
- [x] **Шаг 4. Исполнение** — отдельный процесс через `spawn`/exec (НЕ `fork`:
      тредпул OCCT после форка виснет), `rlimit` во внешней обёртке плюс таймер и
      `SIGKILL` в родителе, ограниченный тредпул OCCT. СДЕЛАНО: `src/buildproc/`
      (`limits`, `wrapper`, `child`, `runner`), тесты — `tests/buildproc/`, 36 штук.
      Подробности и намеренные решения — SPEC 8A.2, шаг 4.
- [x] **Шаг 5. Асинхронный приём** — 202, идентификатор задачи, эндпоинт статуса и
      отдача лога сборки тому, кто пушил. **Сделано.** Живёт в `src/jobs.py`
      (`JobStore`, `BuildTask`, `BuildQueue`), тесты — `tests/test_jobs.py`.
      Граница проходит по «нужна ли сборка»: токен, размер, архив и «этот пуш уже
      опубликован» отвечаются НА ПУШЕ (401/413/411/408/400/422/409/200), а всё
      остальное уезжает в задачу и узнаётся через `GET /api/v1/jobs/<id>` и
      `/log` — оба под `PUBLISH_TOKEN`, оба отвечают одинаковым 404 на чужой,
      несуществующий и кривой id. Параллелизм сборки — отдельное число
      (`MAX_CONCURRENT_BUILDS = 2` против `MAX_CONCURRENT_PUBLISHES = 4`),
      обоснования всех потолков — SPEC §7.5. Задача не может остаться без
      терминального состояния: запись в памяти обновляется независимо от тома,
      оба обращения к диску best effort, а ошибка ПОСЛЕ `rename` не помечает
      задачу провалившейся, потому что `rename` и есть публикация. Порядок задач
      хранится СПИСКОМ ID в одном файле `data/jobs/order.json`, а не числом в
      каждой записи и не по `created` (секундная точность не переживает рестарт):
      порядок — свойство набора, а не записи, и размазанный по N файлам он не
      переживал записи, доехавшей наполовину. Каталог, которого файл порядка не
      называет, читается как самый старый. SIGTERM обрабатывается в `main.py` — будит
      заранее созданный поток, а не запускает новый из обработчика, — остановка
      сначала закрывает сокет, потом дренирует очередь вместе с исходниками, а
      воркеров ждёт по ОБЩЕМУ бюджету (`WORKER_JOIN_SECONDS` на весь пул, не на
      поток). Реестр лежит на томе, писчем для сборки: запись приводится к
      известной схеме, у `job.json` и `log.txt` — потолки на размер и при чтении,
      и при записи (SPEC §7.4).
- [ ] **Долг гейта: проверка (h) в `ci/smoke.py`** — что потолки действительно
      встают ВНУТРИ образа под учёткой `app` и что `-m src.buildproc.*`
      резолвится от `/app`. Долг стал реальным на шаге 5: до него хаб ничего не
      собирал и ломаться было нечему, а теперь сборка стоит на пути запроса, и
      образ, в котором обёртка не запускается, выглядит совершенно здоровым до
      первого пуша. Набор тестов этого не увидит структурно — он гоняется по
      чекауту и в артефакт не смотрит. Закрывать вместе с шагом 6, когда гейт
      переезжает: писать в него сейчас код, который нечем проверить локально,
      хуже, чем держать долг записанным.
- [ ] **Шаг 6. Гейт переезжает и меняет знак** — срабатывает ПОСЛЕ приёма: staging
      выбрасывается, `latest` и `dev` не двигаются, наружу код ошибки с логом.
- [ ] **Шаг 7. Убрать и переписать** — образ `cad_builder`, `publish.yml`, секреты
      `HUB_URL` и `PUBLISH_TOKEN` в организации, `remote.py`, пины `cad_publish`;
      переписать README, AGENTS, спеку и подписи во вьювере.
- [ ] **Хранение исходников по ревизиям.** Решено 2026-08-26: раз хаб
      становится форжем, он обязан хранить код, а не только результат. Сегодня
      дерево исходников удаляется `shutil.rmtree` в `finally` внутри
      `_build_and_publish` — **на всех путях, включая успешный**, — и к ревизии
      привязано только то, что сборка произвела. От самого кода остаётся один
      отпечаток: `metrics.source_fingerprints()` кладёт в метаданные два хеша,
      `written` и `code` (с вырезанными комментариями). Этого хватает ответить
      «исходник менялся или нет» и не хватает ответить «чем именно», и уж точно
      не хватает восстановить модель.

      **Требование:** публично код НЕ раздаётся, но проектировщик должен уметь
      его выгрузить, чтобы вернуться к другой ревизии.

      Отсюда следует место хранения: НЕ внутри каталога сборки. Тот раздаётся
      публично и с годовым `immutable`, поэтому ошибка там необратима — розданные
      копии не отзываются. Хранилище отдельным деревом, отдача под токеном.

      **Дёшево это стоит ровно потому, что тело пуша уже на диске:** приём
      спулит gzip-tar во временный файл и сейчас делает `unlink`. Вместо этого
      `rename` в хранилище — один файл на ревизию, байт в байт присланное, ноль
      новых зависимостей. Ретенция цепляется к ретенции сборок, иначе исходники
      осиротеют.

      **Git рассмотрен и отложен, чтобы не возвращаться.** Из трёх реализаций
      подходит одна: `dulwich` — чистый Python, не требует ни бинарника `git`
      (его нет в образе), ни нативного кода; `pygit2` тянет libgit2, `GitPython`
      это обёртка над бинарником, а не реализация. Но для заявленного требования
      git не нужен вовсе, а цена его реальна: `src/` намеренно держится на stdlib
      поверх pydantic и loguru. Дедупликация ревизий почти ничего не даёт —
      исходники это килобайты против мегабайтов геометрии. И у кода **уже есть**
      канонический git-дом: репозиторий модели в форже, которым пуш и
      адресуется.

      **Проверено по пунктам, что именно git дал бы, и почти всё отпадает.**
      Диффы исходника ему не нужны: код это `.py`, а `difflib` в stdlib даёт и
      построчный, и unified. Слияния не нужны в принципе — хаб принимает
      снапшоты, а не ветки, сливать нечего. История уже есть и без него: ревизии
      адресуются идентификатором коммита, лежат упорядоченно и подчинены
      ретенции, то есть список сборок проекта И ЕСТЬ история в нужном хабу виде.
      Остаётся ровно одно, чего иначе не получить: быть настоящим git-ремоутом,
      чтобы с хаба можно было склонировать. Это отдельная фича, а не следствие
      хранения исходников, и вот под неё — `dulwich`, когда форж поедет внутрь.

      **Оговорка про обратимость, чтобы решение не выглядело безрисковее, чем
      оно есть.** Перейти потом с тарболлов на git можно, каждая ревизия станет
      коммитом, но история выйдет ЛИНЕЙНОЙ и бедной: идентификаторы коммитов из
      URL пуша у нас есть, а графа, авторов и сообщений нет. Настоящий DAG
      задним числом не восстанавливается — он может прийти только из форжа, и
      значит забирать его надо В МОМЕНТ переезда, а не собирать потом из того,
      что накопил хаб.
- [ ] **Шаг 8. Сравнение ревизий** — последним, когда у хаба есть и ядро, и
      исходники, и внепроцессное убийство зависшей задачи из шага 4. Упирается в
      пункт выше: сравнивать геометрию можно и сейчас, буферы лежат, а сказать
      «деталь изменилась, потому что изменилась вот эта строка модели» — нельзя,
      кода нет.
- [x] ~~Завести репозиторий в Gitea и спушить~~ — сделано 2026-08-24:
      `projects/hammerola`, ветка по умолчанию `main`, `origin` настроен.
      `REGISTRY_TOKEN` отдельно не заводился: он есть на уровне организации
      `projects` и наследуется репозиторием.

- [ ] **Удалить эту bootstrap-секцию**, когда чеклист закрыт, и оставить только
      постоянную часть файла.

**Уже принятые решения — не переоткрывать.** Они стоили отдельной работы, и SPEC 8A
объясняет каждое:

- **Зависимости модели — только из образа.** Ничего не ставится по запросу модели:
  установка sdist гарантированно исполняет код, а wheel может положить `.pth`,
  который исполняется при КАЖДОМ старте интерпретатора. `--only-binary=:all:` от
  этого не спасает.
- **Комментарии — заметка агенту, а не публичный канал.** Публичная запись отменена
  решением 8A.1: без токена возникает дорожка от анонимного ввода до выполнения кода,
  не требующая ни одной уязвимости.
- **`keep_instances` не берём.** Он меняет формат экспорта целиком — буферы едут
  base64, лист несёт `{"ref": n}`, — из-за чего ломается пофайловое сравнение по
  байтам буфера. Разобрано не в 8A, а в SPEC 8, запись «Сравнение двух ревизий».
- **VTK принимаем как есть.** Его жёстко требует сам `cadquery-ocp` (`vtk==9.6.2`);
  единственный способ избавиться — подменить дистрибутив на `cadquery-ocp-novtk` в
  обход объявленной зависимости. Экономия ~0.6 ГБ не стоит постоянной хрупкости.

И отдельно — раздел 8A.4 «Чего не делать никогда»: docker-сокет в любом виде,
docker-in-docker и `privileged`, `exec()` модели в процессе хаба, RestrictedPython и
любой in-process барьер, nsjail/bubblewrap внутри Docker, `userns-remap`. Каждый пункт
проверен по источникам, чтобы не возвращаться.

Пока чеклист не закрыт, не считай проект готовым, даже если код формально работает.

<!-- ======================= конец BOOTSTRAP ============================== -->

## Project structure
- `src/` — application code (`settings.py` is the single config entry point)
- `src/cadbuild/` — the build half, moved in from `cad_publish` (SPEC 8A.2 step
  3): take a model's source, compute the geometry, gate it, export the
  artefacts and the viewer payload. Kept as a subpackage rather than spread
  through `src/` because it is a different job from serving: nothing in it
  touches HTTP, the data volume or a credential. Two things import it, and both
  are deliberate: `src/buildproc/child.py` does it INSIDE the build process
  (step 4), and the root `checklib.py` shim re-exports one module of it under
  the name every model.py imports (see the next entry). Nothing on the serving
  side imports it — the gate on the receiving side is step 6
- `src/jobs.py` — the asynchronous half of a push (SPEC 8A.2 step 5): `JobStore`
  is the registry (a directory per job under `data/jobs/`, `job.json` and
  `log.txt` beside it, plus `order.json` for the registry as a whole),
  `BuildTask` is what the request hands over, `BuildQueue` is the bounded queue
  and the worker threads that build and then publish. Read its docstring before
  touching it: `data/jobs/` is on a volume every build can write, so everything
  the registry reads back is rebuilt into a known shape, capped on the way in
  and on the way out — and whatever that normalization changed is WRITTEN BACK,
  because a correction that stays in memory leaves the planted value on disk for
  the next start to read again. The second rule is the one that cost three
  rounds: anything shared BETWEEN records must not be stored per record. The
  write-back writes them one at a time, a build chooses which of those writes
  fails (`chmod 0500` on one directory, no vulnerability needed), and a
  half-applied pass then leaves a state the hub was never in. The creation order
  used to be stored that way and is now one atomically written file. Read what
  that file buys narrowly, because the generous reading is wrong: it stops a
  POINTWISE write failure from reordering the registry, and nothing more. A
  build can write `order.json` outright — real ids, permuted — and the hub
  believes it without a word, exactly as it does a `log.txt` a build overwrote.
  That is accepted rather than fixed: the same build can `rmtree` another job's
  directory, which is strictly more
- `checklib.py` — at the ROOT, and not a stray file: `import checklib` is part
  of the contract with every model.py in the fleet, exactly like `views()` and
  `printables()`. It re-exports `src/cadbuild/checklib.py` under that name, and
  it has to sit at the root because a model is imported with its own directory
  FIRST on `sys.path` (so a project may deliberately shadow it) and the name
  then has to resolve on the path behind it — `/app` in the image. Smoke check
  (g) is what proves it reached the image
- `tests/` — pytest. `tests/cadbuild/` is the moved suite and has a `conftest.py`
  of its own: its `isolated_project` fixture is autouse and would otherwise
  chdir every hub test into a scratch project
- `data/` — runtime state: builds, pointers, comments and build JOBS as a
  directory tree with JSON alongside, no database (gitignored, mounted as a
  docker volume). Note what that last one means: `data/jobs/` is on a volume
  every build can write anywhere in, so nothing there is evidence about who
  wrote it — see the docstring of `src/jobs.py` and SPEC §7.4
- `templates/` — page templates that ship inside the image: `index.html`,
  `build.html`, `pointer.html`, one per URL the hub serves
- `static/` — the viewer payload that ships inside the image (`static/_v/`):
  `three-cad-viewer.esm.js`, the hub's own `viewer.js` driver, the site CSS. A
  separate tree with its own `COPY` line in the Dockerfile and its own smoke
  check (g)
- `ci/smoke.py` — the gate between build and publish: seven checks (a)–(g) the
  test suite structurally cannot make, because it runs against a checkout and
  never looks at the artefact. (b) proves the startup guard names EVERY missing
  variable — both credentials, not just the first
- `docs/SPEC.md` — requirements, verified facts and the work plan (section 8A)
- `main.py` — thin entry point over `src/`

## Setup
All routine actions go through the `Makefile` — run `make help` to list targets.
```bash
make install           # create .venv and install dev/test deps
cp .env.example .env   # then fill in the values  (shortcut: make env)
```

## Running tests
```bash
make test              # runs .venv/bin/python -m pytest
```

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

## Naming — one name for the project, everywhere
The repository, the local working directory, the compose service, the
`container_name`, the Portainer stack and the published image all carry the SAME
name, spelled with underscores (`ukuetis_logger`, not `ukuetis-logger` and not
`ukuetislogger`). Pick it once, at creation, and do not let a short form appear
anywhere.

This is not tidiness. Every one of those names is a lookup key for somebody:
`docker ps` and `docker logs` take the container name, Portainer lists the stack
name, the registry path is the repo name, and an agent asked about "the X service"
greps for one string. When they disagree, every lookup needs a translation table
that exists only in somebody's head — and the failure is silent, because each
individual name still resolves. A real example from this fleet: repo
`proxmox_dns`, directory `proxdns`, container `proxdns`, stack `proxmox-dns`,
image `proxmox_dns` — four spellings of one service, so `docker ps | grep
proxmox_dns` finds nothing on the host that runs it.

Underscores rather than hyphens because the name also has to be a legal Python
package/module name — otherwise the repo name and the import name diverge the
moment anything is imported. The only place a hyphen is acceptable is a DNS name
(`proxdns.borneo.lc`), which is a separate, externally-visible identifier: it may
be shorter, and renaming it breaks links, so it is not covered by this rule.

## Conventions
- **Commit messages are written in English.** Subject in conventional-commit style, body
  explaining WHY rather than restating the diff. This holds even though the design
  documents under `docs/` are in Russian: the log is read with `git log` by tooling and
  by people who did not take part in the discussion, while the documents are read by
  whoever continues the work.
- All mutable state goes under `data/`.
- All config comes from ENV / `.env` (see `.env.example`).
- Credentials / addresses of our own services that the user provides go ONLY into
  `.env` (never into code, never via inline env vars); read them through `Settings`.
- No default/example credentials in code; missing ENV var → fail at startup.
- A default address is allowed ONLY for public third-party APIs (Google, GitHub).
  Addresses of self-hosted services have no default.
- In the compose file, configuration goes in the service's own `environment:` block or in a
  file that TRAVELS with the stack (committed beside `docker-compose.yml` and deployed from
  the repository). Never reference an absolute host path from `env_file:`
  (`/data/<project>/app.env` and the like). Portainer executes compose INSIDE ITS OWN
  container, so that path is resolved in the Portainer server's filesystem, not on the host
  the stack runs on — the file you can see over SSH on the target host is not the file
  compose looks for. An absolute path that happens to line up under today's control plane
  works indefinitely and proves nothing; deployed by a different control plane it fails with
  "env file not found" while the container already running keeps serving traffic. The stack
  therefore stops being DEPLOYABLE without stopping being UP, which means the breakage is
  invisible until the next redeploy — and the redeploy that discovers it is usually a
  migration, i.e. the one moment when everything else is moving too. That is how it went on
  this fleet during the 2026-08-17 consolidation: the affected stacks only deployed again
  after their env files were copied into the Portainer server's own volume.
- Code comments are in English.
- The user-facing interface is in English too — UI text, CLI output, log lines and
  messages a user sees — unless the task explicitly asks for another language.
- All repeated actions (env setup, tests, run) go through `make` targets — add or
  extend a target instead of running ad-hoc commands.
- Python always runs inside a local `.venv`, created automatically by `make` on
  first use (`make test` / `make run` bootstrap it) — never the system Python.
- Python tooling is invoked as `$(VENV)/bin/python -m pip` and `$(VENV)/bin/python -m pytest`,
  never as `.venv/bin/pip` or `.venv/bin/pytest`. A virtualenv that was copied or moved from
  another directory keeps the ORIGINAL absolute path in its console scripts' shebang line, so
  `.venv/bin/pip` would go on installing into a different project's environment while every
  message it prints looks entirely normal. `python -m` resolves the module against the
  interpreter that was actually invoked — the one `make` just created, here.
- Tests are required for new code; in CI `build` depends on `test`.
- Runtime dependencies are pinned with `==`, and a dependency the code imports DIRECTLY is
  named in `requirements.txt` even when it already arrives through another package's extra.
  Inheriting it means an unrelated upgrade up the tree can take it away, and the import then
  fails at startup in production on a commit that changed nothing near it. Comment a
  requirement with what BREAKS without it, not with what it is.
- If a module exposes a singleton, a cache, a registry or any other module-level mutable
  state, the suite gets an autouse fixture that asserts it is clean BOTH before and after each
  test. Before-only is not enough: without the after-check the test that corrupted the state
  goes green and the failure surfaces in an unrelated test later — usually whichever one
  happened to run next, which is where the debugging then starts.
- Between building the image and publishing it there is a GATE — `ci/smoke.py`, run as a
  step of its own in both workflows. Nothing reaches the registry until it is green, and
  `docker login` deliberately runs *after* it: until the gate passes there is nothing to
  publish, so the registry PAT is never on the runner while the Dockerfile's `RUN` steps
  and the image's own code are executing. Do not reorder those steps and do not move the
  login back to the top of the job.
  The gate answers what a green test suite cannot, because the suite runs against a
  checkout and never looks at the artefact: the declared ENTRYPOINT/CMD/WORKDIR, that the
  missing-variable guard still fires *and still names the variable*, that privileges are
  really dropped to `app` (nothing in the image declares a user — the entrypoint is the
  only thing that does it, and if it stops, everything still looks fine), that
  `.dockerignore` kept `tests/`, `.env` and `.venv` out of the image, and that the image's
  own command reaches its startup marker. When you add a check, add it there.
- `docker login` runs AFTER the gate, and that placement is the load-bearing half: until the
  gate is green there is nothing to publish, so there is no moment before it at which the
  registry PAT needs to be in the job's docker config — and everything above that line executes
  untrusted code on a runner shared with every other repository (the Dockerfile's `RUN` steps,
  including whatever `pip install` pulls in, and then the image's own code under the gate). Do
  not move the login back to the top of the job.
  The explicit `docker logout` at the end, under `if: always()`, is defence in depth rather
  than the thing preventing a leak: `docker/login-action` already logs out in its post step
  (`logout:` defaults to true, and act_runner does run post steps), and this job's docker config
  lives inside act_runner's own container anyway. Keep the step regardless — it is what still
  covers the day the login becomes a plain `docker login` run step, or `logout: false` is set,
  or a runner build stops executing post steps, each of which fails silently and leaves a PAT
  behind.
- `ci/smoke.py` counts its own verdicts: every probe declares how many targets it returns and
  the gate fails if the count does not match. That is the gate's guard against its own worst
  failure — a probe that quietly stops probing prints nothing, fails nothing and exits 0, so
  the run is green precisely BECAUSE a check disappeared. When you add or remove a check,
  update the declared count deliberately, as part of the same change; never "fix" a mismatch
  by editing the number to whatever the run happened to produce.
- Exactly four `run:` bodies are BYTE-IDENTICAL between the two workflows and move in lockstep:
  the test step, the gate, the smoke-container cleanup and the test-container cleanup. That
  whitelist IS the rule — it is the whole mechanism keeping the PR gate from drifting into
  testing less than the publishing one, so when you edit one of the four, edit its twin to match
  exactly, and verify it mechanically (hash the bodies) rather than by eye. Everything outside
  the whitelist is free to differ and much of it does: the comments, the `env:` values, the
  timeouts, and the login/push/logout steps that exist in the publishing workflow only. Two
  steps LOOK like they belong on the list and deliberately do not — the BUILD step (the
  publishing workflow computes and builds the registry tags there, the PR workflow builds a
  single local tag it never pushes; unifying them would either put a registry path into a
  workflow a pull request can trigger or take the tag computation out of the one that
  publishes) and the IMAGE-cleanup step (a loop over `$TAGS` in the publishing workflow, a
  single `docker rmi "$SMOKE_IMAGE"` in the PR one). Naming both here is what keeps someone
  from "fixing" them in either direction.
- Every container CI starts is `--name`d, and EVERY removal of one carries `-v` — the cleanup
  steps in both workflows *and* `remove_container()` in `ci/smoke.py`. There are two removal
  paths for the smoke containers, not one, and the flag has to be on both: `ci/smoke.py` removes
  its own containers on the normal path (each one before it starts it, the long-lived ones again
  in a `finally`), so by the time the workflow's `if: always()` step runs there is usually
  nothing left for its flag to apply to. That step exists for the other run — the one where
  `ci/smoke.py` was killed by the smoke step's `timeout-minutes` before reaching its `finally`.
  A `-v` carried only in the workflows would therefore cover exactly the runs that do not
  normally happen, and the day a Dockerfile here declares a `VOLUME`, every ordinary run would
  leak an anonymous volume through smoke.py's own removal. `--rm` does not close that gap
  either: it is removal-on-exit performed by the daemon, so it never fires for a container whose
  docker CLI was killed by a step timeout — the container simply keeps running — and an unnamed
  leftover cannot be removed by anything afterwards, because every cleanup here works by name. On
  a shared, persistent daemon that leak is permanent. `-v` takes the container's anonymous
  volumes with it (there are none until a Dockerfile declares a `VOLUME` — exactly the change
  nobody remembers to pair with a CI edit) and can never touch a named volume.
- `concurrency:` on image-check-publish.yml serialises the runs of a branch, and that
  serialisation is the GROUP's doing on its own: the newest commit's `:latest` is written last
  whatever `cancel-in-progress` is set to, so production never lands on an older commit.
  `cancel-in-progress: false` buys exactly one further thing — be precise about which, because
  the generous reading of it is wrong. It buys that a run which has already STARTED is never
  killed mid-flight, so the `:<sha>` it is building is not lost to a newer push. It does NOT
  buy an image for every commit: a new run of the group always cancels the previous runs that
  are still `Waiting`/`Blocked` — on Gitea (`PrepareToStartRunWithConcurrency` →
  `CancelPreviousJobsByRunConcurrency`, which adds `Running` to that list only when
  `cancel-in-progress` is true) exactly as on GitHub ("any previously pending job or workflow
  in the concurrency group will be canceled"). Three quick pushes therefore still lose the
  middle commit's `:<sha>`, and with an image build measured in tens of minutes that is an
  ordinary occurrence rather than a corner case. Do not build anything on the assumption that
  every commit has an image; when a specific commit needs one, re-run the workflow for it by
  hand.
- `concurrency:` also requires Gitea >= 1.26 — the release that added the syntax to Actions, and
  that removed the built-in "cancel the previous run of this workflow" behaviour it replaced.
  An older instance does not reject the block, it IGNORES it — silently, with nothing in the
  run list or the logs saying so — and the symptom is NOT runs piling up in parallel: the
  built-in cancellation is still there, so a superseded run gets cancelled either way. In
  tests.yml that makes the block a no-op and costs nothing. In image-check-publish.yml it takes
  away the one guarantee named above: the built-in cancellation did not spare a RUNNING run, so
  a build already twenty minutes into producing its `:<sha>` dies when the next push lands, and
  gaps appear from ordinary well-spaced pushes rather than only from bursts. Missing `:<sha>`
  images are therefore not by themselves evidence of an old instance — they happen on a current
  one too. What points at the version is WHICH run was cancelled: a queued one is normal, a run
  that was already building is the older behaviour.
- CI installs no Python on the runner: both workflows run pytest inside a
  `python:3.11-slim` container (the same base the Dockerfile uses), with the workspace
  streamed in as a tar over stdin. Do not "simplify" this to `actions/setup-python` or to
  a bind mount — setup actions are unverified on this runner and fail by silently doing
  nothing, and a bind mount would resolve on the host daemon rather than in this job.
- `ci/smoke.py` publishes no ports and never talks to `127.0.0.1`: the job runs inside a
  container while `docker` drives the host's daemon, so a published port is not reachable
  from the job. Anything that has to be observed inside a container goes through
  `docker exec`.
- No `EXPOSE` in the Dockerfile — Traefik publishes the service via compose labels.
- The container runs as non-root user `app` (uid 1000) — the entrypoint starts as
  root, fixes `/app/data` ownership and drops privileges via gosu. Do not add a
  `USER` directive to the Dockerfile and do not remove the entrypoint.
- The compose file carries one auto-update label, `io.portainer.update.enable`,
  read by the ContainerAutomation auto-update in OUR Portainer build (our fork of
  Portainer — the Gitea repository `projects/portainer` on `gitea.vvzvlad.xyz`, not a
  directory in this repository) — upstream Portainer, CE or BE, has no such mechanism
  at all. Do not add the watchtower-family key beside it — that is unconditional and
  not merely a default: as of the 2026-08-17 consolidation no watchtower and no
  autoheal container was left on any environment of this fleet, and no
  `com.centurylinklabs.watchtower.*` or bare `autoheal` label either (that bare
  key is the sidecar's own — not `io.portainer.autoheal.enable`, which our Portainer
  build reads and which the next bullet is about), so a second key would be dead text
  that still reads like a working fallback.
  What the label buys — the polling, the health gate, the rollback — is a property of
  the CONTROL PLANE that owns the target host, not of the label and not of this
  project. Check WHICH control plane owns the host before relying on it. A host owned
  by a different one — a stock Portainer, say — has no ContainerAutomation at all, so
  the label is an unread string there and the failure mode is silence: the stack
  deploys green and the container simply keeps running the image it was first started
  with, with nothing anywhere reporting that updates stopped. Do not answer this by
  memorising a list of hosts: this fleet has run more than one Portainer at a time and
  ownership of a host has already changed once, which is exactly how the previous
  version of this paragraph went stale. Check the ownership, not the list.
- Do not add `io.portainer.autoheal.enable` beside the update label without deciding to: the
  same Portainer build's auto-heal restarts containers docker reports `unhealthy`, and it can
  MASK the auto-update's rollback gate. The gate polls health every 3 s, so it OBSERVES the
  first `unhealthy` sample within one poll interval (≤3 s) and begins the rollback from there
  — 3 s is when it notices, not when the rollback is finished; auto-heal sweeps every 30 s
  over running containers filtered on `health=unhealthy`, so it cannot see a container that is
  still `starting` and for most of the gate's window the two never meet. The overlap is the
  `unhealthy` state alone — but when auto-heal's tick lands in it first, its restart resets
  health to `starting`, the gate waits out its deadline, and a container that comes up healthy
  on the retry gets the update ACCEPTED: the bad image stays deployed and the log shows a
  normal successful update. That is the right trade where being back up beats a faithful
  rollback (a checker bot, a scraper) and the wrong one where a reproducible deploy matters —
  a trade either way, never an upgrade.
- The healthcheck's timings are part of the deploy mechanism, not cosmetics. After our
  Portainer build recreates a container on that label it waits for docker to report the
  container `healthy` within `max(RollbackTimeout ≈ 120s, start_period + 15s)`, and rolls the
  image back if the window closes first. Docker runs the first probe only after a full
  `interval` unless `start_period` is set, so a long interval without one gets a perfectly
  healthy image rolled back and then suppressed for 24 hours, leaving the service quietly on
  the OLD code. Dropping the healthcheck does not make that gate pass — it disables it
  entirely, and a broken image is never rolled back.
- A compose volume KEY is not the volume NAME: docker-compose prefixes the key with the
  project name, and Portainer uses the STACK name as the project name. When attaching a
  compose file to a deployment that already exists, the resulting `<stack>_<key>` must match
  the volume already on the host — or the volume has to be pinned with `external: true` plus
  an explicit `name:`. A mismatch does not fail anything: docker creates a new, empty volume,
  and the stack comes up looking perfectly healthy with all of its state gone.
