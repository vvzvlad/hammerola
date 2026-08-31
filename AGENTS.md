# Agent Instructions — hammerola

<!-- ======================================================================
     BOOTSTRAP — удали эту секцию целиком, когда её пункты закрыты.
     ====================================================================== -->

## ⚠️ Проект в середине переезда: хаб уже билдер, гейт на приёме ещё не стоит

Код сервиса из `cad_snapshot_hub` уже перенесён — `src/` раздаёт сайт, принимает пуш,
рендерит вьювер и держит очередь комментариев, тесты и шаблоны с ассетами на месте.
Ядро CadQuery уже в образе: пины в `requirements.txt`, системные библиотеки в
Dockerfile, `import cadquery` проверяется гейтом (`ci/smoke.py`, проверка (f)).
Со сборкой хаб уже соединён: с шага 5 пуш принимается асинхронно и модель считается в
отдельном процессе на пути запроса (`src/jobs.py` → `src/buildproc/`). Публиковаться
тоже уже есть чем: клиент живёт здесь же (`src/client/`), ревизию именует хаб по хешу
её исходников, и они хранятся (шаг 7). Чего ещё нет — гейта на приёмной стороне
(шаг 6): сборка с негодной геометрией сегодня публикуется, а не отвергается.
Именно поэтому шаги плана начинаются с приёма ДЕРЕВА исходников (шаг 2), а не с нуля.

**Что это за проект.** `hammerola` (от «пианола» — механизм, который играет сам)
собирает CAD-модели из кода и раздаёт их браузерным вьювером. Он ПОГЛОЩАЕТ три
существующих репозитория, и все три остаются на диске как источник кода и решений:

| Репозиторий | Что оттуда берётся |
| --- | --- |
| `/Users/vvzvlad/Data/Projects/cad_snapshot_hub` | раздача снапшотов, вьювер, приём пуша, комментарии |
| `/Users/vvzvlad/Data/Projects/3d/cad_builder` | образ с CadQuery — ядро геометрии |
| `/Users/vvzvlad/Data/Projects/3d/cad_publish` | сборка модели, гейт на геометрию, публикация |

**Порядок действий, прежде чем писать код:**

1. **Прочитай `docs/SPEC.md`, начиная с раздела 8A** — это план работ проекта.
   Врезка в начале файла объясняет, что в документе актуально, а что описывает
   состояние ДО переезда. Разделы 1–7 — проверенные эмпирически факты и подводные
   камни; перепроверять их не надо, это уже стоило времени. Беклога в документе
   больше нет: он переехал в задачи `projects/hammerola` на `gitea.vvzvlad.xyz`
   2026-08-30, а §8 остался таблицей «запись → issue».
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

**Чеклист незакрытого (шаги плана 8A.2):** здесь только шаги плана — всё
остальное, что переезд не закрывает, живёт задачами в `projects/hammerola` на
`gitea.vvzvlad.xyz`.

- [x] **Шаг 0. Комментарии под токен.** **Сделано.** Публичная запись комментариев
      переведена под токен — это то, что закрывает дорожку от анонимного ввода до
      исполнения кода (SPEC 8A.1): комментарий писался без токена → попадал в
      очередь → агент читал его как задачу → правил `model.py` → хаб исполнял
      `model.py`. Закрыт первый шаг, единственный из пяти, который можно закрыть,
      не отменяя саму фичу. Токен проверяется ПЕРВЫМ — до маршрута, до
      рейт-лимита и до `Content-Length`, — иначе неаутентифицированный
      по-прежнему заставляет хаб принять и разобрать multipart с вложением.

      **Вместе с этим два секрета схлопнулись в один: `EDIT_TOKEN`** (решение
      2026-08-27, issue #26). `PUBLISH_TOKEN` и `COMMENT_READ_TOKEN`
      исчезли. Имя новое, а не старое, и это отдельное решение: `PUBLISH_TOKEN`
      врал задолго до того, как лишился пары — им уже открывались исходники
      ЛЮБОГО проекта (§7.8) и маршрут, УДАЛЯЮЩИЙ проект, — а читался как
      «креденшл CI на пуш», то есть приглашал отдать его CI общей организации,
      что после переезда означает выдать исполнение кода. `EDIT_TOKEN` называет
      право, а не один способ им воспользоваться, и совпадает со словом, которым
      это значение уже называет интерфейс: `View only` против `Editing on`.
      «Токен», а не «пароль», — потому что это общая строка, сверяемая на
      равенство: не на человека, не хешируется, не отзывается по одному, и кто
      её предъявил, хаб не записывает. Обоснования — SPEC §7.5.

      Ничего не сломалось у тех, кто публикуется: по проводу едет ЗНАЧЕНИЕ в
      заголовке `Authorization`, а как свой секрет называет чужой workflow — его
      дело. Миграция деплоя — одна строка в compose.

      **Гейт при этом ослаб, и это записано, а не замолчано.** `ci/smoke.py`,
      проверка (b), доказывала, что сторож на старте называет КАЖДУЮ недостающую
      переменную, а не только первую, — и доказывала тем, что переменных было
      две. С одной второй строки нет. Свойство переехало в
      `tests/test_config_errors.py` (сторожу подсовывают класс настроек с двумя
      обязательными полями); гейт, работающий против собранного образа с
      настоящим `Settings`, так не умеет. Форма списка `REQUIRED_VARIABLES`
      сохранена, объявленное число проверок — выражение от него, так что вторая
      переменная вернёт свойство одной строкой. Заодно появился
      `test_the_gate_knows_every_credential_this_declares`: сверяет список гейта
      с полями `Settings` без дефолта, потому что «держите их в согласии» было
      комментарием, а не проверкой.

      **Рейт-лимита комментариев больше НЕТ, и потолков на их число тоже**
      (решение 2026-08-27, SPEC §7A.4). Шаг 0 сначала оставил рейт-лимит,
      подняв его с 5/10 мин до 30/10 мин, — единственным доводом было «это
      самозалечивающийся потолок, он ловит зациклившегося клиента до того, как
      тот сожжёт сотню слотов сборки насовсем». Довод держался на
      `COMMENT_MAX_PER_BUILD`; вместе с ним и с `COMMENT_MAX_TOTAL` он ушёл, а
      без слотов сторожить нечего. Главное же — дверь теперь одна и она под
      секретом: писать может только обладатель `EDIT_TOKEN`, а он тем же
      секретом стирает проект целиком (`DELETE /api/v1/projects/<pid>`).
      Ограничивать частоту тому, кто может стереть проект, бессмысленно.
      Потолки на РАЗМЕР (тело, вложение, поля), проверка типа вложения по первым
      байтам и отказ от SVG остались: это про недоверенный ввод, а не про
      ретенцию. Разбор всех требований 7A.4 — какие пережили смену посылки, а
      какие отменились — там же, в SPEC §7A.4.

      Ресурсных лимитов контейнера в этом шаге НЕТ намеренно, хотя в SPEC 8A.2 они
      записаны рядом. Там они относятся к УЖЕ РАБОТАЮЩЕМУ хабу, у которого
      контейнер живёт без единого потолка; здесь код сервиса уже перенесён, но он
      ни разу не выкатывался — снимать числа попросту не с чего, а под сборку
      моделей их всё равно придётся пересчитывать. Лимиты ставятся тогда же,
      когда сервис впервые выкатывается, — по замерам, а не наугад.
- [x] **Шаг 1. Ядро в образ.** Пины `cadquery`, `cadquery-ocp`, `ocp-tessellate`,
      `trimesh`; системные библиотеки в Dockerfile (`libgl1`, `libx11-6`, `libexpat1`,
      `libxext6`, `libxrender1`, `libsm6`, `libice6`, и намеренно НЕ `libglu1-mesa`);
      `import cadquery` в smoke внутри собранного образа.
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
      174 теста, свой `conftest.py`). Клиентская половина осталась в
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
      `/log` — оба под `EDIT_TOKEN`, оба отвечают одинаковым 404 на чужой,
      несуществующий и кривой id. Параллелизм сборки — отдельное число
      (`MAX_CONCURRENT_BUILDS = 2` против `MAX_CONCURRENT_PUBLISHES = 4`),
      обоснования всех потолков — SPEC §7.5. Задача не может остаться без
      терминального состояния: запись в памяти обновляется независимо от тома,
      оба обращения к диску best effort, а ошибка ПОСЛЕ `rename` не помечает
      задачу провалившейся, потому что `rename` и есть публикация. Порядок задач
      не хранится вообще — ни числом в записи, ни отдельным файлом: единственным
      его потребителем была ретенция («кого подрезать первым»), а ретенции нет
      (решение 2026-08-27, SPEC §5.3), задачи же читаются по id. Правило, которое
      эта история оставила, шире файла и остаётся в силе: то, что является
      свойством НАБОРА записей, нельзя хранить по записи — проход, доехавший
      наполовину, смешивает два поколения, и место остановки выбирает сборка
      (`chmod 0500` на одном каталоге). SIGTERM обрабатывается в `main.py` — будит
      заранее созданный поток, а не запускает новый из обработчика, — остановка
      сначала закрывает сокет, потом дренирует очередь вместе с исходниками, а
      воркеров ждёт по ОБЩЕМУ бюджету (`WORKER_JOIN_SECONDS` на весь пул, не на
      поток). Реестр лежит на томе, писчем для сборки: запись приводится к
      известной схеме, у `job.json` и `log.txt` — потолки на размер и при чтении,
      и при записи (SPEC §7.4).
- [x] **Шаг 6. Гейт переезжает и меняет знак** — срабатывает ПОСЛЕ приёма: staging
      выбрасывается, `latest` и `dev` не двигаются, наружу код ошибки с логом.
- [x] **Шаг 7. Дать новую дорогу и убрать за собой — В ХАБЕ.** Переформулирован
      2026-08-27, и прежняя редакция здесь названа, чтобы её не восстановили:
      она велела ходить в ЧУЖИЕ репозитории — снести `publish.yml` у каждой
      модели, убрать секреты в организации, отвязать `cad_builder` и
      `cad_publish`. Это не работа хаба. Хаб даёт способ публиковаться; что
      после этого сделают у себя одиннадцать репозиториев моделей — их дело, и
      следующий агент не должен читать этот пункт как задание туда идти.
      Убирать к тому же было нечего: публикация УЖЕ не работала с шага 5 — хаб
      принимал дерево исходников и отвечал 202, а клиент паковал плоскую сборку
      и ждал 201, — и связку не проверял ни один тест, потому что половины жили
      в разных репозиториях. Так что шаг оказался не уборкой, а стройкой.
      **Сделано:** `src/client/` — команда `hammerola`, только stdlib, в ЭТОМ
      репозитории намеренно (контракт у клиента и хаба один, а расходится он
      молча, если обе половины не видит ни один тест); идентификатор ревизии —
      хеш её исходников, git ни при чём (§7.7); исходники и лог хранятся по
      ревизии и отдаются под тем же секретом, что публикует (§7.8); ретенции нет
      ни у сборок, ни у задач (§5.3, §7.3); вычищены утверждения, которые переезд
      сделал ложными — подпись `CadQuery → Gitea Actions` на главной, «`latest` —
      это из CI», «пакет никем не импортируется». **Что осталось — в SPEC 8A.2,
      шаг 7**, и список там живой: набор команд дописывается прямо сейчас, а
      единственный пункт, который не закроется работой, — именованный маршрут
      публикации `<pid>/<commit>`: он живёт, пока по нему кто-то пушит.
- [ ] **Шаг 8. Сравнение ревизий** — последним, когда у хаба есть и ядро, и
      исходники, и внепроцессное убийство зависшей задачи из шага 4. То, во что
      он упирался, шаг 7 снял: код ревизии теперь лежит на томе и отдаётся по её
      имени (§7.8), так что «деталь изменилась, потому что изменилась вот эта
      строка модели» стало вопросом, на который есть чем ответить. Осталось само
      сравнение геометрии по буферам — детали в issue #10 «Сравнение двух
      ревизий».
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
  байтам буфера. Разобрано не в 8A, а в issue #10 «Сравнение двух ревизий».
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
  `log.txt` beside it), `BuildTask` is what the request hands over, `BuildQueue`
  is the bounded queue and the worker threads that build and then publish. Read
  its docstring before touching it: `data/jobs/` is on a volume every build can
  write, so NOTHING there is evidence about who wrote it, and everything the
  registry reads back is rebuilt into a known shape and capped in size on the
  way in and on the way out — and whatever that normalization changed is WRITTEN
  BACK, because a correction that stays in memory leaves the planted value on
  disk for the next start to read again. A build can overwrite another job's
  `log.txt`, or `rmtree` its directory outright, and the hub believes what is
  left; that is accepted rather than fixed, because there is no boundary on the
  volume to fix it with (SPEC 8A.4). Records are never deleted — no retention,
  by decision of 2026-08-27 (SPEC §5.3) — so no count ceiling decides which jobs
  to throw away; only strangers get swept, and only by age. The second rule is
  the one that cost three rounds and outlives the file that taught it: anything
  that is a property of the SET of records must not be stored per record. A pass
  writes them one at a time, a build chooses which of those writes fails
  (`chmod 0500` on one directory, no vulnerability needed), and a half-applied
  pass then leaves a state the hub was never in. Creation order used to be
  stored that way; it is now stored nowhere at all, because retention was its
  only reader
- `src/client/` — the OTHER side of the wire: the `hammerola` command an author
  runs in a model's directory (issue #26). `build` publishes the `dev`
  slot, `commit` publishes an immutable revision; both pack the
  source tree, POST it, poll the job from step 5 and print the build log. THE
  REVISION IS NAMED BY THE HUB, not by the client and not by git (SPEC §7.7):
  the id is the digest of the sources, so `commit` means "publish a version of
  this" and a directory that is not a repository publishes exactly like one that
  is. git is touched once, afterwards: `gitsuggest` prints a `git commit` line
  that RECORDS what was published, for a person to run or ignore — the tool
  never stages and never commits. It is
  in THIS repository on purpose — the client and the hub share one contract (the
  archive shape, the path alphabet, the ceilings, the codes, the job states), and
  publication broke precisely because the two halves used to live in two
  repositories where no test could see both. `tests/client/` now drives the real
  hub over a real socket, and `tests/client/test_limits.py` compares the client's
  copy of the ceilings (`src/client/limits.py`) against `src/store.py` and
  `src/settings.py`. STDLIB ONLY, every module of it: the tool runs under
  whatever python3 a laptop has, so it imports nothing from `requirements.txt` —
  not loguru, not pydantic, not `src.store`, not `src.cadbuild` — and talks HTTP
  with `urllib.request`; `tests/client/test_stdlib_only.py` is what enforces
  that, since the test environment has every dependency installed and would
  never notice on its own. Around the two publishing verbs sit the rest:
  `login` (`setup.py`, writes the machine's `KEY=value`
  file 0600 after checking the password against the hub — ONE secret for the
  whole system, `EDIT_TOKEN`, no second key for comments), `create`
  (`project.py`, mints the
  twelve hex characters of SPEC §3.1 and refuses to write over an existing id;
  `setup.py` then unpacks the starter template beside it, fetching it from
  `/start` — the ONE route this tool asks for with no token, because the reader
  of it may not have one. The id is still minted locally and `--no-template`
  is what keeps that true offline; the download is fetched and its collisions
  are checked BEFORE anything is written, so a failure leaves the directory
  untouched rather than holding a permanent id and no model),
  `status` (`status.py`, assembled out of `builds.json` and the dev slot's own
  `meta.json`, i.e. what the project page already fetches), `comments`
  (`queue.py`, the queue and its `resolve`), and the six added once the hub
  began keeping a revision's sources (issue #17): `source` and `log`
  (`sources.py`), `artifacts` (`artifacts.py`), `diff` (`revdiff.py`), `rename`
  and `rm` (`admin.py`, over the two routes `src/app.py` grew for them). FOUR
  OF THOSE ARE SHAPED BY WHAT THEY MAY NOT DO, and the shape is the decision:
  `source` and `artifacts` are two verbs because the code is behind the secret
  and the artefacts are public; `source` unpacks into a directory of its own and
  writes over the working copy only behind a flag AND a clean git tree; `rename`
  moves the TITLE and there is no way to rename an id, because every permanent
  URL is built from it; `rm` removes the project whole and never one build, and
  asks for the id to be typed first. What each of those fetches lands under
  `.hammerola/` in the project — hidden, so `pack` drops it and the next push
  cannot publish a copy of an older push. Self-update waits on the tool having a
  distribution name. Three gaps are of a different kind and are worth knowing
  before reaching for them: "the last build
  job" cannot be shown at all, because a job is addressable only by its id and
  job order is stored nowhere (see `src/jobs.py`); `hammerola log dev` cannot be
  answered either, because nothing is stored for the local slot on purpose
  (SPEC §7.8) — the command says so rather than answering with `latest`'s log,
  which would be a different build; and the comment routes check the
  same `EDIT_TOKEN` as everything else — the hub's second variable went away in
  step 0, along with the client's sentence explaining a 401 that meant "this
  deployment set its other variable differently"
- `src/buildnames.py` — what a build file may be CALLED, and the one place that
  decides it. Three sides ask the question and they live in three different
  worlds: the file server, of every request for
  `/project/<pid>/<commit>/<name>` (`app._safe_name`); the declaration, of every
  name a push names in `meta.json` (`render._check_declared_file`, on all four
  maps — `views` included, which is the one that had kept a check of its own);
  and the client, of every name the hub hands back before it writes that name to
  the author's disk (`src/client/artifacts.py`). Before this module the rule was
  written out inline in all three, and no two copies agreed: the server refused a
  leading dot, the declaration accepted one, the client had a third and weaker
  approximation. That is the failure it exists to end, and it is silent — a name
  the declaration takes and the server refuses publishes with a 201 into an
  IMMUTABLE directory under a year of cache and then 404s on every GET, so the
  build is accepted and impossible to open, from a push that can never be taken
  back (issue #53). IT IS A MODULE OF ITS OWN because none of the three could
  host it: the import edge runs `app → store → render`, so `render` may import
  neither `app` nor `store` — which also closes `store.py`, the obvious address
  next door to `SAFE_COMPONENT` — and the client is stdlib-only and may not
  import the service at all. STDLIB ONLY for that last reason, and it travels in
  `onboarding.CLIENT_EXTRA_MODULES` beside `src/metricsdiff.py`. WHAT ENFORCES
  the stdlib rule is TWO tests, and they are not the same rule:
  `tests/test_buildnames.py::test_the_shared_module_imports_nothing_but_the_standard_library`
  names this file and allows the standard library and nothing else, while
  `tests/client/test_stdlib_only.py::test_every_client_module_imports_only_the_standard_library`
  reaches it by walking `onboarding.client_members()` — which is where
  `CLIENT_EXTRA_MODULES` puts it — and allows `src` on top of the standard
  library, since the modules it sweeps are the ones that import each other; what
  they may take from `src` is then narrowed by
  `test_the_client_never_reaches_into_the_service_or_the_build_half` beside it.
  Both read the syntax tree rather than importing, so an import buried inside a
  function is caught too. THE ZIPAPP DOES NOT CATCH IT:
  `onboarding._refuse_unimportable` refuses on what
  `_import_closure` reports MISSING, and that walk skips every import whose
  module is not `src` or `src.*` outright. A `numpy` added here therefore enters
  no closure, refuses nothing and is served with a 200 — and the laptop that
  downloaded it is exactly what breaks. `store.SAFE_COMPONENT` deliberately did
  NOT move in beside it: that is a different rule about a different door — the
  alphabet each COMPONENT of an archive member's path is held to on the way IN,
  capped at 128 characters — where this one is about the name of a file a build
  already wrote, on the way out
- `src/metricsdiff.py` — reading `metrics.json`: what a build measured, and what
  moved between two of them. It is NOT a copy of anything and that is the point:
  the document has one writer (the build) and two readers — `cadbuild.metrics`,
  printing what moved since `dev`, and `hammerola diff`, printing what moved
  between two revisions — and the client cannot import the build half. Rather
  than duplicate the comparison (which is exactly the shape of
  `cad_publish/hubspec.py`, the copy that broke publication), the pure half was
  MOVED here and both sides import it; `src/cadbuild/metrics.py` re-exports every
  name it used to define. `tests/test_metricsdiff.py` asserts the two sides hold
  the same objects (`is`, not `==`) and that this module imports only the
  standard library, which is what lets the client have it at all
- `src/onboarding.py` — what the hub hands somebody who has just found it, and
  the only place the `/start` routes are named: the agent skill, the client as
  ONE executable file (a zipapp built at request time out of `src/client/` —
  which works only because the tool is stdlib-only, so a client that grew a
  compiled dependency breaks here rather than on a laptop), the starter
  template, and a manifest naming all three. ALL FOUR ARE PUBLIC on purpose:
  they are the software rather than a statement about what is published here,
  they are byte-identical on every deployment, and the manifest exists to be
  read by somebody who does not have the token yet. The manifest carries ONE
  fact about the deployment — `empty` — and that is the single thing on this
  service answered without authentication. It is deliberately a boolean and must
  never become a count, a name or a date: a count leaks the size of the fleet to
  anyone who polls, and a name is the prefix of every permanent URL that project
  will ever have, which is exactly what `/index.json` sits behind the token to
  withhold. "Empty" means no project directory on the volume WITH ANYTHING IN
  IT (`Store.empty`) — not "no cards on the front page" (a project whose only
  build is in the `dev` slot has no card and is not an empty hub), and not "no
  project directory" either: `build_staging` creates one before the build runs
  and nothing removes it when the build fails the gate, so counting bare
  directories made a hub permanently non-empty the moment its first push failed
  — landing on exactly the reader the answer is for. ALL FOUR MANIFEST FIELDS
  HAVE A READER: `hammerola create` follows `template`, and the SIGN-IN PAGE
  reads `empty` — the gate on everything below — and then follows `skill` and
  `client` when it says this hub has nothing on it
  (issue #48). That block — five lines a person copies and hands to their
  agent — is what the route was built for and what collects on the argument for
  answering a question about the deployment anonymously. It is on the DOOR and
  not on the list, because the list is behind the very token somebody opening an
  empty hub does not have. Its addresses are BUILT, never written down: the
  origin off the browser (`hubOrigin` in `ui/src/hub.js`) and the paths out of
  the manifest. The page asks LAZILY — a
  reader who already has a token goes to the list and never touches this route —
  and every failure of that fetch is silence: a hint must not be able to take a
  sign-in form down (`loadStart` in `ui/src/hub.js`)
- **The client has two doors and no installed script.** Out of a checkout it is
  `python3 -m src.client`, STARTED IN THE CHECKOUT ROOT because that is where
  `src` is importable — so the model directory is an argument and not the shell's
  cwd: `python3 -m src.client -C <model dir> status`, or
  `PYTHONPATH=<checkout> python3 -m src.client status` from inside the model.
  Plain `python3 -m src.client` run in a model directory fails with
  `No module named 'src'`, which is the mistake this bullet exists to head off.
  No venv, nothing to build, because the package
  imports the standard library and nothing else; everywhere else it is the
  one-file zipapp the hub serves at `/start/hammerola`. There is no
  `bin/hammerola` and no `make client` any more, and that is a correction rather
  than an omission: the target symlinked that file into `~/.local/bin`, which is
  the very name the hub's bootstrap writes with `curl -o`, and a write through a
  symlink lands in the link's TARGET — so the download quietly overwrote the
  repository's own copy while the command went on working, with `git status` as
  the only symptom. A packaging entry point is not the fix and is deliberately
  still absent: this repo's one importable top-level name is `src`, and `pip
  install`ing that onto a laptop would shadow every other project's `src`.
  Giving the tool a distribution name belongs with the self-update work
- `checklib.py` — at the ROOT, and not a stray file: `import checklib` is part
  of the contract with every model.py in the fleet, exactly like `views()` and
  `printables()`. It re-exports `src/cadbuild/checklib.py` under that name, and
  it has to sit at the root because a model is imported with its own directory
  FIRST on `sys.path` (so a project may deliberately shadow it) and the name
  then has to resolve on the path behind it — `/app` in the image. Smoke check
  (g) is what proves it reached the image
- `tests/` — pytest. `tests/cadbuild/` is the moved suite and has a `conftest.py`
  of its own: its `isolated_project` fixture is autouse and would otherwise
  chdir every hub test into a scratch project. `tests/client/` has one too, and
  it takes two things AWAY from every test in it: the `EDIT_TOKEN` that
  `tests/conftest.py` puts in the environment for `src.settings` (the client
  reads the same name and would push with the wrong secret), and the developer's
  real `~/.config/hammerola/env` (a suite that read it could pass only on a
  configured machine — or push at a live hub)
- `data/` — runtime state: builds, pointers, comments and build JOBS as a
  directory tree with JSON alongside, no database (gitignored, mounted as a
  docker volume). Note what that last one means: `data/jobs/` is on a volume
  every build can write anywhere in, so nothing there is evidence about who
  wrote it — see the docstring of `src/jobs.py` and SPEC §7.4
- `templates/` — page templates that ship inside the image: `index.html`,
  `build.html`, `pointer.html`, one per URL the hub serves
- `static/` — the viewer payload that ships inside the image (`static/_v/`):
  `three-cad-viewer.esm.js`, the scripts for the pointer page, the
  site CSS and `favicon.svg`. A separate tree with its own `COPY` line in the
  Dockerfile and its own smoke
  check (g). FOUR OF THESE FILES ARE READ BY `ui/tests/chrome.test.js`, so all
  four are named on the JS tar line of both workflows: `site.css` (the resolver's
  copy of the header) at module scope, `favicon.svg` through a walk of this
  directory for `.svg`, and `pointer.js` / `pointer_pref.js` through the walk
  that sweeps for a second copy of the mark. `favicon.svg` is held to two
  document-level checks and nothing about geometry — the icon is a related
  drawing, not the mark (see `brand/`). It is found by WALKING this directory
  for `*.svg` rather than by being named, but that walk only ever sees what CI
  put on the runner, and the JS tar names files here ONE AT A TIME (the viewer
  bundle in this directory is 3.5 MB, which is why). So a new `.svg` dropped in
  here is checked on a workstation and INVISIBLE to both workflows until the two
  tar lines name it as well — the asymmetry is deliberate and worth knowing:
  `brand/` travels whole, so a new drawing there is checked everywhere at once.
  NOT EVERYTHING IN `static/_v/`
  IS COMMITTED: files matching
  `hammerola*` are the browser bundle, produced by `make ui` or by the image's
  `ui` stage, and they are in `.gitignore` and `.dockerignore` both. Never
  commit one, and do not expect one in a fresh checkout — an asset that belongs
  in the repository has to be a name outside that prefix
- `brand/` — the mark as the designer drew it, and the SOURCE the two inline
  copies of it are transcribed from: `Mark` in `ui/src/style.jsx` and the
  `<svg>` in `templates/pointer.html`, neither of which can import a file (one
  would make the bundle emit a second output, the other is on the page whose
  whole job is to leave quickly). `ui/tests/chrome.test.js` compares all three
  element for element, so these are derived copies rather than similar ones —
  every attribute as the union of both sides, the `<svg>` ROOT included, with a
  named exception list that itself has to keep excusing something. Two of its
  checks are about a file being a VALID drawing rather than the same one, and
  both close a way of rendering wrong while comparing equal: every attribute
  name has to be spelled the way SVG spells it (`strokewidth` draws the ribbon
  as a hairline, `CX` slides a hole off it to the left edge), and nothing may
  sit inside the `<svg>` but shapes (a `<style>` block — which is what an editor
  exports by default, and what the old favicon had — repaints the drawing past
  every comparison there is). Those two apply to `static/_v/favicon.svg` as
  well, which is otherwise held to nothing here: the icon is a RELATED drawing,
  not this one, so comparing its geometry would be wrong — but it is the SVG
  that ships in the image and is served to browsers, and it is where the
  `<style>` block came from. Every one of those per-document lists is itself
  checked by name against a single naming of the four files, because a list
  entry deleted is a check that vanishes with the suite still green — the same
  failure `ci/smoke.py` counts its verdicts to avoid.
  Nothing here is served or copied into the image: it is a source asset, named
  in `.dockerignore` so that stays true the day somebody widens a `COPY`, and
  the site icon it shares a design with is a served one, so that lives at
  `static/_v/favicon.svg` and is deliberately NOT duplicated here.
  **THE TWO FILES ARE NAMED AFTER THE BACKGROUND, NOT THE INK** —
  `mark-on-light.svg` is the DARK ink, for a light page. They arrived named the
  other way (`-dark` for dark ink) and that reading is a coin toss whose losing
  side is an invisible logo, so the test asserts the naming: each file's ribbon
  has to be on the opposite side of mid-grey from the background its name
  promises. Only `mark-on-light.svg` is rendered today, because the interface is
  light everywhere; `mark-on-dark.svg` is wired in by issue #35, and is
  kept — rather than dropped as dead weight — because its geometry is held to
  the same check meanwhile
- `model_template/` — the starter project `hammerola create` unpacks, served at
  `/start/template.tar.gz`: a `model.py` that BUILDS AS IT STANDS, plus a
  `.gitignore`. It is files rather than a section of documentation for one
  reason, and that reason is the only thing keeping it honest:
  `tests/test_template.py` runs it through `run_build` — the same entry point a
  push takes — so a template that stopped satisfying the gate fails here instead
  of being handed to somebody who cannot tell whose fault it is. That test skips
  where the CAD kernel does not import, i.e. in CI; the shape checks beside it
  do not, and they are what catch the edit that actually happens (a file added
  under a name the path alphabet refuses, which takes down the whole push of
  every project made from it). It carries NO `project.json`: `create` mints the
  id, and an id shared by every project made from a template is the one thing an
  id may never be. The NAME is not `template/`, deliberately: that is one letter
  from `templates/` next to it, both are copied to the root of the image by
  adjacent COPY lines, and two names that differ by a letter are how a COPY or an
  ignore rule ends up on the wrong one while each still resolves
- `skill/SKILL.md` — instructions for an agent working in a MODEL's repository,
  not in this one, served at `/start/skill.md` and installed into
  `~/.claude/skills/hammerola/`. What it exists to say, and what nothing else
  says anywhere: `build` fills the draft slot and leaves the project off the
  front page, `commit` is what makes a version exist, and finished work is
  committed. The rest is the model contract (pointing at `model_template/` as the
  example rather than restating it) and the four rules whose breach refuses a
  push — the path alphabet, a `checklib.py` of one's own, dependencies, and the
  fact that `model.py` is executed by the hub. It carries no address: the reader
  substitutes their own hub
- `ui/` — the React sources for the browser UI, and the only place node is used
  here. Built twice, by two toolchains that must not disagree: `make ui` for a
  workstation and the Dockerfile's `ui` stage for the image. Nothing under
  `src/` imports or executes anything in it, which is why `make run` and
  `make test` work on a machine with no node at all. The output path is written
  in five files that never import each other, and `tests/test_ui_bundle.py` is
  what keeps them in step; `ui/README.md` has the layout and the pins
- `ci/smoke.py` — the gate between build and publish: eight checks (a)–(h) the
  test suite structurally cannot make, because it runs against a checkout and
  never looks at the artefact. (b) proves the startup guard fires and NAMES the
  missing variable. It used to prove more — that the guard names EVERY missing
  variable, not just the first — and it could, because there were two
  credentials; with one (`EDIT_TOKEN`, step 0) that property moved to
  `tests/test_config_errors.py`, which can hand the guard a settings class with
  several required fields. Read `REQUIRED_VARIABLES` there before assuming the
  gate still covers it.
  (h) is the only check here that makes a REQUEST — it asks the running
  container for the three `/start` files, two of which are assembled when the
  request arrives and so cannot be checked by naming a path at all. It is a
  witness for the whole client only because the assembly REFUSES when a module
  reachable from `src/client/cli.py` did not reach the image
  (`onboarding._refuse_unimportable`); the glob that collects those modules
  cannot see a file that is not there, so without that refusal a stripped image
  served a 200 and an archive that died on the laptop that downloaded it
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
- Exactly six `run:` bodies are BYTE-IDENTICAL between the two workflows and move in lockstep:
  the Python test step, the JS test step, the gate, the smoke-container cleanup and the two
  test-container cleanups — one per suite. That whitelist IS the rule — it is the whole
  mechanism keeping the PR gate from drifting into testing less than the publishing one, so
  when you edit one of the six, edit its twin to match exactly, and verify it mechanically
  (hash the bodies) rather than by eye. `tests/test_workflow_steps.py` is that hashing, run on
  every push: it compares all six and also asserts that the two look-alike steps named below
  have NOT been unified, so the rule is now checked rather than merely written down — keep the
  count there and the word "six" here in step with each other. Everything outside
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
