# Дисциплина моделирования: наряд на работу

Шесть изменений в сборочной половине хаба. Каждое превращает правило, которое сегодня
живёт прозой в чьей-то инструкции, в машинерию, срабатывающую саму — в `src/cadbuild/`,
`checklib.py` и `model_template/`, то есть внутри образа, где новая проверка доезжает до
всех проектов со следующей сборкой и ничего не надо обновлять на машине автора.
Единственное исключение — подпункт 6.1: он чинит не проверку, а не подключённый провод,
и потому идёт по пути пуша (`src/store.py`, `src/jobs.py`, `src/buildproc/`), а не по
геометрии.

Документ — задание кодеру. Он не описывает, «как хорошо бы», а называет файл, строку,
сигнатуру, поведение на краях и тест. Разделы читаются по отдельности; порядок выполнения
и зависимости — в конце, там же список того, чего делать НЕ надо.

---

## 0. Рамки, действующие на все шесть пунктов

Прежде чем писать первую строку — прочитать `AGENTS.md` в корне. Он обязателен целиком,
но вот пункты, о которые эта работа спотыкается чаще всего.

**Язык.** Комментарии в коде — по-английски. Всё, что видит пользователь (строки лога,
сообщения об ошибках, docstring-и), — по-английски. Этот документ по-русски, потому что
он документ разработки; ни одна его фраза не переезжает в код как есть.

**Комментарий объясняет ПОЧЕМУ, а не что.** Посмотри на `gate.PRINT_OVERLAP_TOL` или на
абзац про `relative=False` в `printables.py:122-129` — это образец плотности, которую
здесь держат. Новая константа без объяснения, откуда взялось её значение, здесь не
пройдёт ревью; особенно в пункте 4, где весь смысл работы — в происхождении чисел.

**Тесты обязательны для нового кода** (`AGENTS.md`, Conventions). Сборочная половина
тестируется в `tests/cadbuild/`, у неё свой `conftest.py` с autouse-фикстурами
`guard_module_state` и `isolated_project`. Тесты там намеренно НЕ требуют CAD-ядра:
`fakes.py` подсовывает `Workplane`/`Shape`/`Box` с теми методами, которые гейт реально
зовёт. Всё, что можно проверить без ядра, проверяется без ядра — в CI обоих workflow
`import cadquery` падает на `libGL.so.1`, и тест с ядром там пропускается.

**Модульное состояние.** «Если модуль держит синглтон, кэш, реестр или любое другое
изменяемое состояние уровня модуля, в набор добавляется autouse-фикстура, проверяющая
чистоту ДО и ПОСЛЕ каждого теста» (`AGENTS.md`). Сегодня таких две штуки:
`paths._root` и `checklib._INTERFERENCE`, обе сторожатся
`tests/cadbuild/conftest.py:72-81`. Пункты 2 и 4 добавляют по одному новому реестру —
оба обязаны попасть в ту же фикстуру, в том же виде.

**`checklib` обязан оставаться ОДНИМ объектом.** Прочитай докстринг `checklib.py` в
корне целиком (строки 1-54). Коротко: модель импортируется со своим каталогом первым в
`sys.path`, поэтому шим лежит в корне и находит реализацию ПО ПУТИ, ни разу не назвав
имя `src`. `pairwise_interference` записывает измеренные объёмы в состояние уровня
модуля, а `cadbuild.metrics.collect_metrics` читает эту запись через пакетную половину:
два объекта модуля — это две записи, модель наполняет одну, `metrics.json` читает
другую, и числа пропадают без единого красного. Отсюда правило для пунктов 2 и 4:

* каждое новое публичное имя дописывается в блок ре-экспорта `checklib.py:137-144`
  И в `__all__` (строки 154-163);
* новое состояние читается через ФУНКЦИЮ (`recorded_clearance()`), как
  `recorded_interference()`, а не через ре-экспорт словаря;
* `tests/cadbuild/test_checklib.py::test_everything_a_model_calls_is_re_exported`
  дополняется новыми именами — это единственное, что ловит забытую строку в шиме.

**Потолки сборки.** `src/buildproc/limits.py`: `wall_seconds = 120`, `cpu_seconds = 300`
(суммируется по потокам), `occt_threads = 2`, `output_bytes = 512 MiB`,
`output_files = 4096`. Всё, что добавляют пункты 1 и 2, тратится из этого бюджета, и
цена каждой новой функции ниже посчитана явно. Ориентир: сегодняшняя сборка шаблона
укладывается в единицы секунд, реальная сборка с фаской на каждом ребре — в десятки.

**«Ложный красный дороже пропуска».** Это уже записано в коде и является здешней
доктриной: `modelchecks.count_checks` (строки 148-153) отказывается возвращать 0 в любом
неоднозначном случае, потому что «неверное „пустой checks()“ покраснеет на рабочей
модели, что гораздо дороже, чем не напечатать число». Довод не про то, что кого-то
нельзя ломать, — про то, что проверка, не умеющая отличить законную форму от негодной,
обязана НАЗЫВАТЬ, а не отказывать: отказ, срабатывающий на правильном коде, автор
выключает, и вместе с ним выключается всё, что стояло рядом. Пункт 3 целиком построен
на этом доводе; там же он и разобран до конца.

**Куда попадают файлы сборки.** Это понадобится в пункте 1, и это неочевидно.
`build()` возвращает список `files` (`build.py:89-92`), и этот список решает ровно три
вещи:

* родитель проверяет КАЖДОЕ НАЗВАННОЕ ИМЯ — что оно не выходит за `out_dir`, что ни один
  компонент пути не симлинк, что файл существует и обычный (`runner._verified_files`,
  `src/buildproc/runner.py:499-534`);
* хаб ОТКРЫВАЕТ и читает каждый названный файл, складывая `{имя: sha256}`
  (`store._hash_output`, `src/store.py:2595-2621`). Хеши в `meta.json` не попадают — эта
  карта нужна на публикации: `render.build_meta` разрешает `views` и `downloads`
  указывать только на её ключи (`src/render.py:373-378`);
* и, как следствие, только через `downloads`/`views` имя вообще попадает в `meta.json`
  (`render.py:414-430`) — то есть становится известно клиенту.

Всё, что в списке НЕ названо, **публикуется наравне с названным и раздаётся по своему
URL**. Публикация — это `os.rename` всего каталога staging (`store.py:1417-1419`), а
`_finish_staging` (`store.py:2111-2138`) перед этим только дописывает `meta.json` и
отпечаток пуша; ничего не отсекается и не вычищается. Маршрут
`/project/<pid>/<build>/<file>` (`app.py:744-755`) отдаёт любой файл из каталога сборки,
и единственный фильтр — `_safe_name` (`app.py:536-545`): не пустое, без ведущей точки,
без слеша.

Именно так сегодня живут PNG-превью: они пишутся, не объявляются и при этом **доступны**
— `<hub>/project/<pid>/dev/assembled_preview.png` отдаёт картинку прямо сейчас. Не
хватает не файла, а объявления, и стоит это трёх вещей: имени нет в `meta.json`, поэтому
вьювер картинку не показывает, а `hammerola artifacts` её не забирает (он ходит строго по
`downloads`, `src/client/artifacts.py:19-27`); каталог сборки нигде не перечисляется, так
что имя надо знать заранее; и файл не проходит ни проверку имени родителем, ни открытие
на публикации.

Мелочь, которая понадобится в пункте 1: `.png` нет в `BUILD_CONTENT_TYPES`
(`app.py:258-264`) — эта таблица знает `.json`, `.stl`, `.step`, `.stp`, `.3mf`.
Картинка сборки уезжает как `application/octet-stream` с `Content-Disposition:
attachment`. (`.png` в `app.py:274` — это `ATTACHMENT_CONTENT_TYPES`, вложения к
комментариям, к файлам сборки отношения не имеющие.)

---

## 1. Рендер вида `print`

### Сейчас

`src/cadbuild/build.py:64-67`:

```python
    print("rendering:")
    assembled_parts = export_assembled(prepared, printables, out_dir)
    render_previews(out_dir, list(printables) + [ASSEMBLED_STEM], preview_mode,
                    parts={ASSEMBLED_STEM: assembled_parts})
```

Превью рендерятся каждой сборкой: стемы — все печатаемые детали плюс `assembled`, файл
пишется как `out_dir/<stem>_preview.png` (`assembly.py:125`, имя собирается по
`artifacts.py:7`). Эти файлы публикуются и раздаются: `assembled_preview.png` уже сегодня
лежит по `<hub>/project/<pid>/dev/assembled_preview.png` (механика — в разделе 0).

**Чего нет — это вида `print`.** Его нет среди стемов, и появиться сам он не может:
`render_previews` (`assembly.py:91-138`) рендерит из STL, лежащего рядом
(`out_dir/<stem>.stl`), а `print.stl` никто не пишет. Пишется `print.json` — payload
тесселятора для браузера (`views.export_views`, имя файла `f"{vid}.json"`). То есть
раскладка на столе, в ориентации печати, существует только внутри вьювера: свесы, что
лежит вниз лицом, влезает ли всё в стол — то, по чему судят печатаемость, — есть в
браузере и больше нигде. Это единственный вид, у которого нет картинки, и единственный, в
котором видно стол.

**Второе: ни один PNG не объявлен.** `render_previews` возвращает список записанных имён,
а `build.py:66` его ВЫБРАСЫВАЕТ; в `files` (`build.py:89-92`) попадают только
`meta.json`, `metrics.json`, файлы видов и значения `downloads`. То же и с
`assembled.stl` — пишется и не объявляется. Следствия ровно три, и они не про
доступность: имени нет в `meta.json`, поэтому вьювер картинку не показывает, а
`hammerola artifacts` её не забирает; имя не проходит проверку родителем
(`runner._verified_files`); файл не открывается на публикации (`store._hash_output`).

**Риск ли это.** Довод, а не тон. Проверка родителя ловит четыре вещи, и для
необъявленного файла существенна одна — симлинк. Её докстринг (`runner.py:508-513`)
говорит прямо: `resolve()` ловит ссылку, УКАЗЫВАЮЩУЮ НАРУЖУ, но ссылка, указывающая
обратно ВНУТРЬ тома, «resolves to a path that passes any containment test, while still
being a link the hub then copies or serves». Раздача проверяет ровно containment:
`_send_file` резолвит путь и требует `resolved.relative_to(store.root)`
(`app.py:565-568`). На томе же лежат `sources/` — код ревизий, закрытый EDIT_TOKEN-ом
(`app.py:1209-1233`) — и `jobs/` (`jobs.py:427`). То есть необъявленный симлинк в
опубликованном каталоге — это единственная известная дорожка к чтению закрытых байт через
публичный маршрут.

Оценка: **дырой, в которую можно пройти, это не является**, и вот почему. Цель надо
НАЗВАТЬ по имени, а имена там — sha256 архива и id задания; ни то ни другое не
публикуется, а перечисления каталога на сервисе нет нигде и намеренно. Всё, что лежит под
`project/`, и так публично. Но property, которое даёт `files`, — «в опубликованный
каталог попадает только то, что родитель проверил», — сегодня на превью не
распространяется, и объявление их чинит бесплатно.

Общий случай (необъявленный симлинк вообще, от любой модели) этот наряд НЕ закрывает и
закрывать не должен: это решение о публикации целиком — вычищать ли staging, чем и с
какими последствиями для рабочих файлов, — и протаскивать его коммитом про превью нельзя.
Назвать в отчёте владельцу хаба — да, отдельной строкой.

### Нужно

Работа не «начать отдавать превью» — они отдаются. Работа в трёх вещах.

**(а) Отрендерить недостающий вид.** Собрать меш вида `print` тем же приёмом, что
`assembled`: склеить объекты вида в `Compound`, выгрузить одним STL под именем
`print.stl`, отрендерить из него `print_preview.png`. Это единственный вид без картинки и
единственный, где видна раскладка на столе, — то есть единственное место, где вообще
может появиться то, чего у агента нет.

**(б) Объявить превью в `files`.** Записанные PNG, `print.stl` и `assembled.stl`
дописываются в список, который возвращает `build()`. Что это покупает — три вещи, ни одна
из которых не «доступность»: имя проходит проверку родителем (`_verified_files`), файл
открывается на публикации (`_hash_output` — нечитаемое имя роняет публикацию сразу, а не
превращается в 404 через неделю), и имя становится ГОДНЫМ для `meta.json`: `build_meta`
пускает в `downloads` только ключи этой карты.

**(в) Как превью доезжает до клиента: `hammerola artifacts`, через `downloads`.**
Решение принято, довод такой.

Альтернатива — новый ключ `previews` в `meta.json` и новый глагол (или флаг) у клиента.
Она честнее по смыслу: `downloads` — это «что печатать и чем открыть», а картинка не
файл для печати. И она дороже ровно на всё: валидация нового ключа в
`render.build_meta`, его же в `_hash_output`-контракте, новая ветка в клиенте, тесты на
обеих сторонах и второе понятие, которое человеку надо помнить, — ради двух файлов.

Против неё есть и довод по существу, не только по цене. `artifacts` уже проводит ровно
ту границу, которая здесь нужна, и проводит её осознанно: он не тянет файлы видов,
потому что «they are the viewer's tessellation payload… nothing outside the browser has a
use for them» (`src/client/artifacts.py:19-27`). Превью — это противоположный случай:
файл, который имеет смысл ТОЛЬКО вне браузера, потому что внутри браузера есть сам 3D.
Класть его в тот же список, что STL, — не натяжка, а то же самое различение с другой
стороны.

Цена решения названа и ограничена: метка из `downloads` становится кнопкой на странице
сборки (`render.py:373-378` — метка это подпись кнопки), то есть на каждой странице
появляются две новые кнопки. Две на сборку, а не по одной на деталь, — и это же довод за
то, чтобы подетальные `<name>_preview.png` в `downloads` НЕ клались: десять деталей это
десять кнопок, а сама деталь в браузере и так видна. Подетальные остаются объявленными в
`files` и доступными по своему URL — имя выводится из имени детали, и оно теперь
проверенное и стабильное.

Итого в `downloads` четыре записи: метки `assembled.stl`, `assembled.png`, `print.stl`,
`print.png` (метки — не имена файлов; файлы — `assembled_preview.png` и
`print_preview.png`).

**Попутно, в том же коммите — две правки, без которых работа половинчата.**

1. `.png` дописывается в `BUILD_CONTENT_TYPES` (`app.py:258-264`). Иначе картинка,
   которую теперь предъявляет кнопка, уезжает как `application/octet-stream` с
   `Content-Disposition: attachment` и в браузере скачивается вместо того, чтобы
   открыться. Безопасно и объяснимо: `nosniff` уходит с КАЖДЫМ ответом
   (`app.py:346`), поэтому HTML, названный `x.png`, браузер как документ не отрисует —
   именно ради этого свойства таблица типов и существует (`app.py:337-341`).
   **Только `.png`, и ни в коем случае не `.svg` заодно.** Список узок намеренно: файлы
   сборки приезжают в пуше, URL сборки вечный и того же происхождения, что весь хаб, а
   SVG исполняется — `logo.svg`, отданный «естественным» типом, это хранимый XSS,
   который уже не отозвать, потому что годовые `immutable`-кэши розданы. По той же
   причине SVG запрещён и во вложениях к комментариям (`app.py:267-272`).
2. Докстринг `store._hash_output` (`src/store.py:2606-2609`) утверждает, что каталог
   сборки держит и рабочие файлы, «(the preview renderer writes PNGs nothing in
   meta.json points at)». После этого пункта пример становится ложным. Правится в том же
   коммите: он стоит ровно в том месте, где следующий читатель решает, можно ли доверять
   списку `files`, и врать там дороже всего.

### Сигнатура и форма

В `src/cadbuild/assembly.py`, рядом с `assembled_shape`/`export_assembled`:

```python
def print_plate_shape(prepared):
    """The `print` view glued into one shape, or None when the model has no such view.

    Exactly the shape `assembled_shape` has, and for the same reason: a compound
    is one file, one download and instant, where a boolean union of a plate is
    minutes and can fail. Returns `(shape, objects)`, or None -- a project
    without a `print` view is not made to have one.
    """


def export_print_plate(prepared, out_dir):
    """Write `print.stl` -- the bed as one mesh. Returns (bodies, bbox), or None.

    The bounding box is measured BEFORE the export, for the reason
    printables.py:101-106 gives: exportStl meshes the shape in place and from
    then on OCCT measures the box off the mesh. `drop_mesh` afterwards, exactly
    as export_assembled does -- the objects belong to the model and the
    tessellation is shared through the TShape even by translated copies.
    """
```

Имя стема — это идентификатор вида, и не по совпадению: `print.json`, `print.stl` и
`print_preview.png` — три формы одного вида. Поэтому НЕ заводи третью константу со
значением `"print"`. `assembly.py` уже импортирует `ASSEMBLED_VIEW_ID` из `.views` —
добавь туда же `PRINT_VIEW_ID` и используй его как стем. `printables.py` тоже придётся
импортировать `PRINT_VIEW_ID` из `.views`; цикла нет, `views.py` не импортирует
`printables`.

`build.py` (заменяет строки 64-67 и правит 89-92):

```python
    print("rendering:")
    assembled_parts, assembled_bbox = export_assembled(prepared, printables, out_dir)
    plate = export_print_plate(prepared, out_dir)

    stems = list(printables) + [ASSEMBLED_STEM]
    counts = {ASSEMBLED_STEM: assembled_parts}
    if plate is not None:
        stems.append(PRINT_VIEW_ID)
        counts[PRINT_VIEW_ID] = plate[0]
    else:
        print("print view: none, so no print_preview.png")
    previews = render_previews(out_dir, stems, preview_mode, parts=counts)
```

`parts=counts` — не украшение: подпись одной детали говорит, водонепроницаем ли меш, а
для плиты этот вопрос бессмыслен (соприкасающиеся детали слипаются в одно тело при
загрузке). Плита обязана прийти со своим числом тел.

`downloads` дополняется в `build()` после экспорта, потому что наличие вида `print`
известно только после `prepare_views`:

```python
    downloads.update(overview_downloads(previews, plate is not None))
```

Функция `overview_downloads` — в `printables.py`, рядом с `download_labels`, и её метки
проверяются тем же `LABEL_RE`. Метки: `assembled.stl`, `assembled.png`, `print.stl`,
`print.png` — все четыре проходят `LABEL_RE` (1-32 символа из букв, цифр, точки, тире,
подчёркивания).

**Резервирование имени.** Сегодня `collect_printables` (`printables.py:61-66`)
отказывает детали с именем `assembled`, потому что она столкнулась бы с
`assembled.stl`. Ровно та же коллизия появляется у имени `print`, и она хуже: деталь
`print` экспортируется в `print.stl` на строке 59, плита переписывает этот файл на
строке 65, а хеширует его хаб уже после — то есть опубликованный `print.stl` окажется
плитой, а не деталью, молча. Сделай из двух проверок одну:

```python
RESERVED_STEMS = {ASSEMBLED_STEM: "the glued-together assembly",
                  PRINT_VIEW_ID: "the print plate"}
```

и одно сообщение, называющее, чем занят стем.

### Края и отказы

* **Вида `print` нет.** Ни `print.stl`, ни `print_preview.png` не пишутся, в `downloads`
  двух записей нет, сборка идёт дальше. Печатается одна информационная строка
  `print view: none, so no print_preview.png` — БЕЗ префикса `warning:`. Префикс здесь
  запрещён: `tests/test_template.py:206-210` превращает любое `warning:` в падение теста
  шаблона, а односоставная модель, у которой вид `print` не нужен (единственная деталь
  и так экспортируется в ориентации печати), не должна получать выговор.
* **В виде `print` одна деталь.** Рендерится. Это по-прежнему стол, просто с одной
  деталью на нём.
* **В виде `print` есть мок покупного железа.** Рендерится как есть: на столе
  показывают то, что показывают, и мок в виде `print` — уже сообщение автору о том, что
  вид собран неправильно, а не задача этого кода.
* **Деталь названа `print` или `assembled`.** `BuildError` на этапе имён, до единого
  треугольника — там же, где сегодня отказывает `assembled`.
* **`preview_png` не импортируется** (нет matplotlib). `render_previews` уже
  деградирует в предупреждение и возвращает `[]` (`assembly.py:113-118`). Тогда
  `previews` пуст, и `overview_downloads` не должен объявить ни одной картинки:
  `downloads`, указывающий на несуществующий файл, — это отказ публикации на стороне
  хаба (`render.build_meta`, `src/render.py:376-378`). Стройте карту из фактически
  записанных имён, а не из ожидаемых.
* **Плита не водонепроницаема / состоит из кусков.** Не проверяется и не должна: гейты
  «водонепроницаемость» и «одно тело» (`printables.py:138-156`) применяются к деталям, а
  плита по построению — несколько тел.
* **`print.stl` большой.** Он суммарно не больше суммы деталей плюс моки. `file_bytes`
  = 256 MiB, `output_bytes` = 512 MiB; риска нет. Рендер защищён
  `MAX_RENDER_FACES = 80_000` (`preview_png.py`), то есть плита из миллиона
  треугольников будет прорежена, а не будет рендериться минуту.

### Тесты

`tests/cadbuild/test_assembly.py` — новый файл, без CAD-ядра, на `fakes.py`:

* `print_plate_shape` возвращает `None`, когда среди `prepared` нет вида с
  `id == "print"`.
* `print_plate_shape` берёт объекты именно вида `print`, а не первого попавшегося.
* Все тела каждого объекта попадают в плиту (объект, собранный `.add()`, — несколько
  тел; это тот же дефект, который лечили в `as_shapes`).
* `overview_downloads` не объявляет картинку, которой нет в списке записанных.
* Каждая порождённая метка проходит `LABEL_RE`.

`tests/cadbuild/test_naming.py`:

* деталь с именем `print` отвергается, сообщение называет плиту;
* существующий тест про `assembled` продолжает проходить (одна проверка вместо двух не
  должна потерять старое сообщение).

`tests/test_template.py`:

* `EXPECTED_ARTEFACTS` дополняется `print.stl`, `print_preview.png`,
  `assembled_preview.png`, `base_preview.png`, `lid_preview.png` — шаблон имеет вид
  `print`, значит обязан их отдавать; список именован явно, чтобы «шаблон тихо перестал
  экспортировать» падало здесь;
* лог сборки шаблона по-прежнему без строк `warning:`.

`tests/test_serving.py`, рядом с `test_downloads_are_served_as_bytes` (строки 255-263):

* `.png` из каталога сборки уезжает как `image/png`, с `nosniff` и БЕЗ
  `Content-Disposition: attachment`;
* существующий `test_an_uploaded_html_file_can_never_be_active_content` (строки 266-280)
  обязан продолжать проходить как есть — `page.html` и `logo.svg` остаются
  octet-stream-вложением. Это и есть граница: расширение из белого списка получает свой
  тип, всё остальное — вложение, и `nosniff` держит обе половины.

`tests/test_publish.py` или `tests/test_serving.py`: превью, объявленное в `files` и не
названное ни в `downloads`, ни в `views`, публикуется и раздаётся по своему имени. Тест
фиксирует, что объявление в `files` — это про проверку и хеш, а не про видимость.

---

## 2. Проверки печатаемости в `checklib`

### Сейчас

`src/cadbuild/checklib.py` содержит ровно три функции: `pairwise_interference`
(строка 174), `mating_face_flat` (259), `material_under_head` (373). Про печать нет
ничего. И есть прямой запрет, который надо уважать, — `checklib.py:51-56`:

```python
# There is no wall-thickness check here on purpose. Measuring a wall by firing
# rays along surface normals gave a false red on ordinary spline geometry --
# lofts, sweeps, imported STEP -- and no amount of filtering the artefacts made
# the number trustworthy. Thin walls are looked at by eye, on the preview and
# in the slicer.
```

Это не «ещё не сделали», это результат неудачной попытки. Новая проверка минимального
элемента обязана быть устроена принципиально иначе — иначе она вернёт ту же ложь.

### Нужно

Две проверки в ГЕЙТ и четыре функции в `checklib`. Граница между ними проходит по
одному вопросу: **знает ли ответ сборка, или его знает только автор.**

**В гейт идёт то, что универсально и не требует ни одного числа от автора.** Обе новые
гейтовые проверки живут в `printables.export_printables`, где меш уже загружен
(`printables.py:139`) и габарит уже измерен (строки 107-114), то есть обе бесплатны:

* **деталь обязана касаться стола.** `first_layer_mm2 == 0` (см. пункт 6) означает, что
  в экспортированной ориентации деталь не лежит ни на чём: она не печатается вообще,
  без всяких допусков и без вопроса «а сколько тут терпимо». `BuildError`, называющий
  деталь и её нижнюю точку;
* **деталь не может быть тоньше нитки целиком.** Минимальный габарит детали ниже
  `minimum_feature()` — это деталь, которая печатается одной линией во всех трёх
  измерениях. Универсально при любом сопле, считается из уже измеренного `bbox_mm`.
  `BuildError`.

Ни та ни другая не имеет параметра, который надо угадывать, — поэтому им место в гейте,
и поэтому они срабатывают сами, на каждой сборке, без строчки в `checks()`.

**В `checklib` идёт то, чей порог — проектное решение.** Четыре функции ниже требуют
чисел, которых у сборки нет и не может быть: сколько неподдержанной площади терпит ЭТА
деталь, на каких высотах у НЕЁ несущие стенки, каким инструментом её собирают, по какой
степени свободы ходит пара. Гейт, подставляющий такое число за автора, подставляет
чужое число — это не осторожность, это ложь в вердикте. Все четыре — в том же
контракте, что три существующие: принимают геометрию, возвращают СПИСОК строк-проблем,
пустой когда всё хорошо; зовёт их `checks()`.

#### 2.1 `unsupported_area` — площадь неподдержанных граней

**По мешу, и по тому мешу, который уже лежит на диске.** Доводы:

* свес — свойство треугольника, а не грани: у цилиндрической грани нормаль меняется по
  поверхности, и «нормаль грани» для неё не определена. Именно на этом и погорела
  прошлая попытка мерить стенки по нормалям B-rep;
* `printables.py:139` уже загружает экспортированный STL через trimesh для гейта
  водонепроницаемости — файл на диске, разбор дешёвый;
* `checks(out_dir)` получает каталог сборки и уже умеет в него ходить
  (`model_template/model.py:270`);
* STL детали лежит в той ориентации, в которой деталь ЭКСПОРТИРУЕТСЯ, а шаблон учит
  строить деталь в ориентации печати (`model_template/model.py:78-82`). То есть проверка
  меряет ровно ту ориентацию, о которой она.

```python
def unsupported_area(stl_path, max_area_mm2, *, name="part",
                     max_angle_deg=45.0, bed_tol=0.2, max_rays=512):
    """Downward-facing surface with nothing under it, in square millimetres.

    Catches the overhang the author would otherwise have to find by eye on a
    preview. A triangle counts when its normal points below -cos(max_angle_deg)
    AND a ray dropped from its centroid hits nothing else in the mesh AND it is
    not sitting on the bed (within `bed_tol` of the mesh's lowest point, which
    is the first layer and is supported by the plate).

    `max_area_mm2` HAS NO DEFAULT on purpose. Some unsupported area is normal --
    a chamfer under a rim, a short bridge -- and a number picked here would be a
    number picked for somebody else's part. Saying how much this design tolerates
    is the author's decision, and writing it down is the point.

    Cost: the mesh is already on disk (the gate wrote it); loading is
    milliseconds. Ray casting is trimesh's pure-numpy intersector -- no
    pyembree in the image -- vectorised over triangles per ray, so it is
    `rays x triangles`. Only downward triangles are cast from and only the
    `max_rays` largest of them, so the worst case is bounded: 512 rays against a
    80k-triangle mesh measured under two seconds. Raise `max_rays` and pay for it.
    """
```

Сообщение о проблеме обязано называть площадь, долю от бюджета и КООРДИНАТУ худшего
места — «есть свесы» без места стоит ровно столько же, сколько «посмотри глазами».

#### 2.2 `thin_walls` — минимальный элемент

**По солиду, классификатором точек, вдоль прямых линий на названной плоскости.** Доводы:

* нормали B-rep запрещены прошлым опытом (`checklib.py:51-56`);
* `_classifier` (`checklib.py:90-110`) уже есть, отвечает за микросекунды на точку и
  считает ON материалом; `material_under_head` построен на нём же;
* сечение вместо поверхности убирает проблему сплайнов целиком: сечение лофта — это
  обычный контур, и толщина в нём измеряется без единой нормали;
* новых зависимостей не нужно. `shapely` в `requirements.txt` не закреплён (пришёл бы
  транзитивно и «плавает» — см. комментарий `requirements.txt:60-62`), поэтому
  эрозия полигонов через `Path2D.polygons_full` отпадает.

Метод: на плоскости `z` бежим сканирующими линиями вдоль осей с шагом `pitch`,
пробуем точки вдоль линии с шагом `step`, меряем длину каждого непрерывного «внутри»
участка. Участок короче `min_thickness` — тонкая стенка.

**У метода односторонняя ошибка, и это его главное достоинство.** Стенка под 45° к оси
сканирования измеряется в √2 раз толще, чем она есть, — то есть метод ПРОПУСКАЕТ тонкое,
но никогда не обвиняет толстое. Здешняя доктрина («ложный красный на чужой рабочей
модели дороже непечатанного числа», `modelchecks.py:148-153`) требует именно такой
знак ошибки. Сканирование по четырём направлениям (X, Y и две диагонали) сжимает
худший случай до ~1.08×, и это разумный дефолт.

```python
NOZZLE_MM = 0.4
# Two extrusion widths. A wall thinner than that is printed as a single line,
# and a single line comes out at whatever width the slicer felt like: the
# nominal thickness stops being a dimension. This is the number a 0.5 mm thread
# crest on a 0.4 mm nozzle was under, and the 100 g of scrap that followed.
EXTRUSION_LINES = 2


def minimum_feature(nozzle_mm=NOZZLE_MM, lines=EXTRUSION_LINES):
    """The thinnest wall this machine prints as a dimension rather than a line."""


def thin_walls(part, planes, min_thickness, *, name="part",
               pitch=None, step=None, axes=("x", "y", "xy", "yx")):
    """Walls thinner than `min_thickness`, measured on named sections.

    `planes` are heights in the part's own coordinates -- Z is the section
    normal, so a part modelled on its side is sectioned on its side. NAMED, not
    swept: the author says where the load-bearing and mating walls are, which is
    the difference between a check that can be trusted and the one this file
    refuses to have (see the note at the top of this module).

    `pitch` defaults to `min_thickness` (a wall cannot hide between two scan
    lines that close), `step` to `min_thickness / 4`.

    ONE-SIDED ERROR BY CONSTRUCTION: a wall oblique to a scan axis measures
    thicker than it is, so this misses and never falsely accuses. Four axes cut
    the worst case to about 1.08x.

    Cost: `(span / pitch) x (span / step)` classifier calls per axis per plane.
    For a 60 mm part at a 0.8 mm minimum that is ~75 lines x ~300 samples x 4
    axes = 90k probes, a few hundred milliseconds. It is linear in the number of
    planes, so a model naming twenty heights pays twenty times -- name the
    heights that matter.
    """
```

#### 2.3 `tool_access` — доступ инструментом

**По солиду, классификатором, а не булевой операцией.** Доводы: булева операция
цилиндра против каждой детали сборки — это то, что `pairwise_interference` уже называет
недешёвым (`checklib.py:225-227`, там ради этого стоит отбраковка по габаритным
коробкам); классификатор строится один раз на деталь и отвечает за микросекунды. Точность
у выборки та же, что у `material_under_head`, который здесь уже принят.

```python
def tool_access(obstacles, names, *, origin, direction, diameter, length,
                name="fastener", rings=4, around=16, ignore=()):
    """A straight cylinder from a fastener head must be empty.

    Catches the screw that is modelled, seated and unreachable: a boss in the
    way of the driver, a wall 3 mm from the head, a lid that has to be on before
    the screw can go in. Nothing in the geometry is wrong -- it just cannot be
    assembled, which is found in your hands.

    `origin` is (x, y, z) of the head's seat, `direction` a vector pointing the
    way the tool comes from (it is normalised here; it does NOT have to be Z --
    that is what separates this from material_under_head, which probes along Z
    and only along Z). `diameter` is what has to be clear -- the driver, the
    socket, the ratchet head, whichever is fattest -- and `length` how far it
    has to be clear for.

    Probes a cylinder: `around` points on each of `rings` radii, at
    `int(length / (diameter / 2)) + 2` levels along the axis, against every
    obstacle's classifier. `ignore` names parts allowed to be in the path.

    KNOWN GAP: sampling, so a blade thinner than the probe spacing between two
    levels is not seen. Tighten `rings`/`around` where that matters. The cost is
    `rings x around x levels` classifier calls per obstacle -- ~1000 probes
    against a ten-part assembly is single-digit milliseconds.
    """
```

#### 2.4 `swept_clearance` — прогон пары по степени свободы

Это та функция, которая в разборе была написана руками и оказалась единственной, что дала
ответ: ноль пересечений во всех 18 положениях. Одна статическая проверка на собранном
положении такого сказать не может в принципе.

**По солиду, и здесь булевы операции оправданы**, потому что число положений называет
автор и оно мало (десятки, не тысячи). Плюс замер минимального зазора через
`BRepExtrema_DistShapeShape` — это единственное, что даёт число вместо «не пересекается».

```python
def swept_clearance(moving_positions, fixed, *, names=("moving", "fixed"),
                    min_gap=None, tol=DEFAULT_VOLUME_TOL, label=None):
    """One mating pair, run along its degree of freedom, measured at every stop.

    `moving_positions` is the moving part ALREADY PLACED at each position -- a
    list the model builds, because only the model knows the kinematics. Ten to
    twenty stops is the useful range: a static check at the assembled position
    says nothing about the middle of the travel, and the middle of the travel is
    where a lid catches a rim.

    At every stop: the shared volume (an interference is a hard problem string,
    the same rule pairwise_interference applies) and the minimum distance
    between the two solids. `min_gap` is optional -- given, a stop closer than
    that is a problem; omitted, the gap is only measured and RECORDED.

    Records `{label: {"positions": n, "min_gap_mm": x, "at": i}}` in module
    state, read back by cadbuild.metrics into metrics.json, exactly as
    pairwise_interference records volumes. `label` defaults to "a|b" from
    `names`. That record is what makes a shrinking clearance visible in
    `hammerola diff` instead of in a printed part.

    Cost: one bounding-box reject, then one boolean and one distance per stop.
    A boolean on a real part is tens of milliseconds and a distance the same, so
    18 stops is under a second and 500 stops is not something to do inside a
    120-second build.
    """


def recorded_clearance():
    """`{label: {...}}` for every pair swept_clearance has measured so far."""
```

### Края и отказы

* **`unsupported_area`, файл не существует** — `ValueError` с текстом, называющим, что
  `checks(out_dir)` получает каталог сборки и что имя STL — это имя детали из
  `printables()`. Не `BuildError`: `run_checks` уже оборачивает исключения модели
  (`modelchecks.py:305-307`).
* **`unsupported_area`, меш без единого нисходящего треугольника** — пустой список
  проблем и записанный ноль. Ноль — это результат, а не отсутствие результата.
* **`thin_walls`, плоскость вне детали** — на сечении нет ни одного «внутри»: это не
  «стенок нет», это «вы указали не туда», и функция обязана сказать именно так, отдельной
  проблемной строкой. Ровно та же логика, что у `mating_face_flat`, которая жалуется на
  `nothing lies in the plane z=...` (`checklib.py:360-365`).
* **`thin_walls`, `min_thickness <= 0`** — `ValueError`. Ноль здесь означает «всё
  проходит», а проверка, которая проходит всегда, хуже отсутствующей: это буквально
  предмет пункта 3.
* **`tool_access`, `length` или `diameter` не положительны** — `ValueError`, по тому же
  доводу, по которому `material_under_head` отказывается от нулевой глубины
  (`checklib.py:413-420`).
* **`tool_access`, имя из `ignore` не среди `names`** — `ValueError`. «Исключение для
  детали, которой нет, не исключает ничего» — дословно тот же довод, что в
  `pairwise_interference` (`checklib.py:208-216`) и `views.nested_pairs`.
* **`swept_clearance`, меньше двух положений** — `ValueError`: одно положение это
  статическая проверка, для неё есть `pairwise_interference`.
* **`swept_clearance`, OCCT сдался на вырожденной паре** — как в
  `pairwise_interference` (`checklib.py:231-237`): проблемная строка «эту пару проверь
  глазами», а не исключение. Прогон продолжается.
* **Все четыре, `part` не CadQuery-объект** — `_shape()` уже даёт `TypeError` с
  внятным текстом; пользуйся им, не пиши свою проверку типа.
* **Новое состояние `_CLEARANCE`** обязано попасть в `tests/cadbuild/conftest.py:72-81`
  (обе проверки, до и после), в докстринг той фикстуры и в ре-экспорт шима — по правилу
  из раздела 0.
* **`NOZZLE_MM = 0.4` — публичная константа сопла в общем файле, и это число КОНКРЕТНОЙ
  машины.** В докстринге напиши прямо, что это дефолт, а не факт, и что проект с другим
  соплом обязан передать своё — и объявить его `measured()` по пункту 4. Обе гейтовые
  проверки, которые от неё зависят, берут её как дефолт, а не как истину.
* **Деталь не касается стола / тоньше нитки целиком** — `BuildError` из
  `export_printables`, до записи чего бы то ни было. Обе цифры уже измерены к этому
  моменту, так что проверка не стоит ничего и не может «не успеть».

### Тесты

`tests/cadbuild/test_checklib_printability.py` — новый файл. Часть тестов не требует
ядра, часть требует; вторые пропускаются через `pytest.importorskip("cadquery",
exc_type=ImportError, ...)` — точный образец в `tests/test_template.py:174-178`
(аргумент `exc_type` обязателен, без него pytest 9.1 перестанет пропускать и CI
покраснеет).

Без ядра:

* `minimum_feature()` — арифметика, включая явную проверку, что 0.5 при сопле 0.4 не
  проходит (тот самый гребень резьбы из разбора);
* валидация аргументов всех четырёх функций: нулевые/отрицательные размеры, одно
  положение, неизвестное имя в `ignore`, не тот тип;
* `recorded_clearance()` — пустой в начале, отдаёт копию, которую вызывающий не может
  испортить (зеркало `test_the_record_is_a_copy_callers_cannot_corrupt`);
* реестр общий между шимом и пакетом (зеркало
  `test_the_record_is_shared_between_the_two_names`);
* AST-тест «ни одна из четырёх не зовётся из `src/cadbuild/`» — граница между гейтом и
  `checklib` проходит по тому, кто знает число, и она должна быть проверяемой, а не
  подразумеваемой;
* обе гейтовые проверки: деталь без первого слоя отвергается и сообщение называет её;
  деталь тоньше `minimum_feature()` по минимальному габариту отвергается; обычная
  деталь проходит обе.

С ядром, на минимальной геометрии, которую тест строит сам:

* `unsupported_area`: плита с полкой на кронштейне даёт неподдержанную площадь, равную
  площади полки в пределах допуска; та же деталь, повёрнутая на 180°, даёт ноль (это
  тест на то, что функция меряет ориентацию, а не форму);
* `unsupported_area`: первый слой (нижняя грань на столе) НЕ считается свесом;
* `thin_walls`: стенка 0.5 мм при `min_thickness=0.8` находится и координата названа;
  стенка 1.6 мм — нет;
* `thin_walls`: стенка под 45° толщиной 0.5 мм — тест ФИКСИРУЕТ односторонность ошибки
  (либо находится, либо нет — но никогда не находится там, где стенка толстая);
* `tool_access`: винт у стенки — путь перекрыт, названа мешающая деталь; тот же винт,
  отодвинутый, — чисто; деталь, названная в `ignore`, не мешает;
* `swept_clearance`: крышка, садящаяся на борт, не пересекается ни в одном из 18
  положений и записывает минимальный зазор; крышка на 0.3 мм шире — пересекается в
  середине хода и НЕ пересекается в собранном положении (это ровно тот дефект, ради
  которого функция существует, и тест обязан его воспроизвести).

---

## 3. Тавтологические проверки

### Сейчас

`modelchecks.count_checks` (`modelchecks.py:128-196`) читает исходник `checks()` и
считает места проверок; `run_checks` (строки 276-284) отказывает сборке, если счёт
доказуемо равен нулю:

```python
    count = count_checks(checks)
    if count == 0:
        raise BuildError(
            "checks() is defined but contains no check: no assert, no raise, "
            "nothing filling the list it returns, not even a call to anything. ...
```

Механизм есть, и он именно тот, о котором спрашивают. Но `assert abs((a - b) - c) <
1e-9`, где `a`, `b`, `c` — константы модуля, для него ПРОВЕРКА: это `ast.Assert`,
`total += 1`. Она проходит всегда и не проверяет ничего. В разборе такие ассерты стояли
в живых проектах (два из пяти в одном `checks()`), проходили ревью и пропустили брак в
печать.

### Что технически возможно

Поймать их статически можно, и это не гипотеза. Нужно:

1. знать, какие имена в теле `checks()` — ЛОКАЛЬНЫЕ (цели `Assign`/`AugAssign`,
   переменные `for`, `with ... as`, параметры функции, имена в comprehension). Всё
   остальное разрешается в глобалях модуля;
2. иметь сами глобали. У `run_checks` объект модуля на руках (`run_checks(model,
   out_dir)`), так что `vars(model)` доступен — этого у `count_checks` сегодня нет,
   значит анализу нужен второй аргумент;
3. закрытый мини-вычислитель по AST, признающий выражение СТАТИЧЕСКИМ только если оно
   собрано из: `Constant`; `Name`, разрешающегося в глобалях в `int`/`float`/`str`/
   `bool`/`None`/кортеж таких; `UnaryOp` (`+`, `-`, `not`); `BinOp` (арифметика);
   `Compare`; `BoolOp`; `Tuple`/`List` из статических; вызова `abs`/`min`/`max`/`round`
   из встроенных, с уже статическими аргументами. Всё прочее — не статическое. Вычислять
   выражение целиком нельзя (`10**10**10` вешает интерпретатор), поэтому у `Pow` нужен
   потолок на показатель, и у результата — на величину.

Работы тут на один вечер, и она надёжна: ложное «статическое» невозможно по построению
— неизвестный узел выводит анализ в «не знаю».

### Где проходит граница, и почему это НЕ повод отказывать сборке

Проблема не в вычислителе, а в том, что «обе стороны — константы» и «тавтология» — это
РАЗНЫЕ множества, и они пересекаются на совершенно законных проверках:

```python
assert FIT_MIN < FIT_MAX, "the fit window is inside out"      # обе — константы
assert LENGTH <= BED_X, "does not fit the bed"                # обе — константы
assert WALL >= 2 * NOZZLE, "the wall prints as a single line" # обе — константы
```

Все три статически разрешимы, все три полезны, все три срабатывают ровно тогда, когда
надо: когда кто-то поправил число наверху файла. Вторая и третья — это буквально то, чего
пункты 2 и 4 добиваются от авторов. Отказывать за них сборке — значит наказывать за
единственную форму проверки параметров, которая вообще существует.

Отличить их от `abs((a-b)-c) < 1e-9` статически можно только одним способом: посмотреть,
не выведена ли одна константа из других на уровне модуля (`c = a - b`), — тогда ассерт
доказуемо повторяет определение. Это ловит ровно ту форму, которая была в разборе, и
не ловит соседнюю (`c = 0.25` рядом с `a - b == 0.25`), которая тавтологична ровно так
же. То есть даже уточнённое правило половинчато.

И есть довод сильнее любого технического, он уже записан в этом же файле,
`modelchecks.py:148-153`: «этот файл общий для всех проектов организации, и неверное
„пустой checks()“ покраснеет на чьей-то рабочей модели, что гораздо дороже, чем не
напечатать число. Каждое правило здесь написано так, чтобы нечитаемое тело кончалось на
None и никогда на 0».

### Нужно: не отказ, а имя и число

Стоит ли оно того — **частично да**. AST-анализ написать стоит, а вот вешать на него
отказ — нет. Делай так:

1. **Предупреждение на каждое место.** Строка `warning:` из `run_checks`, называющая
   номер строки, сам ассерт и то, чем он является:

   ```
   warning: checks() line 231: `assert abs((LIP_CLEARANCE - GAP) - 0.0) < 1e-9` is
   decided by the constants at the top of model.py alone -- it holds no matter what
   the geometry came out as, and it will go on holding after the model has drifted
   away from it. A check about the shape has to READ the shape: measure the two
   faces and compare what came out. (A deliberate guard on the parameter table --
   `assert FIT_MIN < FIT_MAX` -- is this same shape and is fine; this line is a
   note, not a refusal.)
   ```

   Предупреждение, а не отказ, ровно потому, что отличить второй случай от первого
   нельзя.

2. **Не считать их в общем счёте.** `run_checks` печатает
   `checks: 5 passed (2 of them decided by the constants alone)`. Если статических
   оказалось ВСЁ — счёт уходит в `None` («count unknown»), а не в 0: ноль означает
   отказ, а мы только что решили не отказывать. Это тот же приём, которым `_reraises`
   (`modelchecks.py:51-67`) вычитается из счёта, но не может уронить его в ноль.

3. **Положить число в `metrics.json`** (см. пункт 6): `checks_static`. Тогда проект,
   у которого настоящая проверка выродилась в тавтологию, виден в `hammerola diff` как
   `checks passed: 5 -> 5, checks decided by constants: 1 -> 3`. Это ровно тот вид
   доказательства, который отказ дать не может: он показывает ТЕНДЕНЦИЮ, а не разовый
   вердикт, и не рискует ложным красным ни разу.

### Сигнатура и форма

В `src/cadbuild/modelchecks.py`:

```python
# Builtins an assert may call and still be decidable from the source. Pure,
# total, and cheap: nothing here can have a side effect or refuse to return.
STATIC_BUILTINS = {"abs": abs, "min": min, "max": max, "round": round, "len": len}

# The biggest exponent a static `**` may carry. `2 ** 10 ** 10` is a legal
# expression and evaluating it is how this analysis would hang a build.
MAX_STATIC_POW = 64


def local_names(tree):
    """Every name the function binds itself: parameters, assignment targets,
    loop variables, `with ... as`, comprehension variables, `except ... as`."""


def static_value(node, constants):
    """The value of an expression decidable from `constants`, or NOT_STATIC.

    NOT_STATIC is a sentinel object rather than None, because None is a value an
    expression can honestly have.
    """


def static_asserts(func, namespace):
    """`[(lineno, source)]` for the asserts whose truth the constants settle.

    `namespace` is the model module's globals. Returns [] when the source cannot
    be read -- the same rule the counter follows: unreadable ends at "nothing to
    say", never at an accusation.
    """
```

`count_checks` не меняется (его контракт «сколько мест проверки в исходнике» остаётся
верным). Вычитание происходит в `run_checks`, и оттуда же печатаются предупреждения.
`run_checks` начинает возвращать пару:

```python
CheckReport = namedtuple("CheckReport", "passed static")
```

`build.py:62` и `build.py:84` подстраиваются; `collect_metrics` получает обе цифры.

### Края и отказы

* **Нет исходника** (`checks` — не питоновская функция, exec'нутый модуль):
  `static_asserts` возвращает `[]`. Ничего не утверждается.
* **Имя есть в глобалях, но его значение — CadQuery-объект, функция, модуль:** не
  константа, ассерт не статический. Правильно: `assert body.val().isValid()` не должно
  попадать в этот список никогда.
* **Имя переопределено внутри `checks()`:** локальное, ассерт не статический. Это
  главный источник ложных срабатываний, и `local_names` обязан покрывать все формы
  связывания, включая `for name in ...`, walrus и `except ... as`.
* **Ассерт статически ЛОЖЕН:** он и так уронит сборку при исполнении, с собственным
  сообщением. Ничего специального не делаем; предупреждение до него всё равно не
  доживёт.
* **`assert True` / `assert 1`:** статический, попадает в список, получает
  предупреждение. Соблазн отказать именно на этой форме есть — не поддавайся: одно
  правило, одно поведение, и исключение из него потом никто не вспомнит.
* **`checks()` вообще нет:** `run_checks` возвращает `CheckReport(0, 0)`, как сегодня
  возвращает 0.
* **Шаблон не имеет права нести статический ассерт.** `warning:` смертелен ровно в
  одном месте — в тесте шаблона (`tests/test_template.py:206-210`), — и это правильно:
  шаблон учит всему, что в нём написано. Сегодня все три его ассерта читают локальные
  значения (`gap`, `over`, `size`); после пункта 5 перепроверь, что новый пример этого
  не сломал.
* **Формат строки лога меняется:** `checks: N passed` → `checks: N passed (M ...)`.
  `tests/test_template.py:215-220` проверяет `line.startswith("checks: ")`,
  `" passed" in line` и `"unknown" not in line` — новый формат все три условия
  сохраняет. Больше эту строку в репозитории не парсит ничто; убедись `grep`-ом, прежде
  чем менять её ещё раз.

### Тесты

`tests/cadbuild/test_modelchecks.py` (дописать в существующий файл, стиль оттуда же):

* два константных ассерта распознаются, локальный — нет;
* `assert FIT_MIN <= gap <= FIT_MAX` при локальном `gap` НЕ статический — это главный
  тест на отсутствие ложных срабатываний, и он должен быть первым в файле;
* имя, затенённое локальным присваиванием, не статическое (по одному тесту на форму:
  `=`, `+=`, `for`, `with ... as`, walrus);
* имя, разрешающееся в функцию или в объект без `__eq__` со скаляром, не статическое;
* `abs`, `min`, `max` со статическими аргументами — статические; `open(...)` — нет;
* `2 ** 10 ** 10` не вешает анализ и не считается статическим;
* нет исходника — пустой список, не исключение;
* `run_checks` печатает предупреждение и число, и `CheckReport.static` равен ожидаемому;
* `checks()`, состоящий ТОЛЬКО из статических ассертов, даёт `passed is None`
  («count unknown») и **не роняет сборку** — это тест на принятое решение, и его
  докстринг обязан объяснять почему, чтобы следующий читатель не «починил» его в отказ.

---

## 4. Провенанс чисел

### Сейчас

Ничего. Константа посадки/зазора/натяга — это `float` в шапке модуля с комментарием
рядом, а комментарий не читает никто, включая автора шесть недель спустя. В разборе:
константа с комментарием `# measured fit on the printer`, которая не измерялась никогда,
стоила двух печатей и 100 г пластика; в другом проекте стоит `confidence = measured`, а
каталога `ref/` в проекте нет вообще.

Ближайшее, что есть в коде, — `metrics.source_fingerprints` (`metrics.py:123-158`),
который считает два хеша исходника, в том числе «без комментариев», ровно чтобы
переписанный комментарий не читался как изменение модели. То есть машинерия уже знает,
что комментарий — это не данные.

### Нужно

Форма записи — **обёртка в точке определения**, а не комментарий и не отдельная
структура. Довод решающий и он один: комментарий надо парсить (и он отвяжется от
константы при первом переносе строки), отдельный словарь `PROVENANCE = {...}` — это
второй список, который расходится с первым при первом переименовании и молчит об этом.
Обёртка ЯВЛЯЕТСЯ константой, поэтому разойтись ей не с чем:

```python
LIP_CLEARANCE = checklib.measured(0.25, "ref/measurements.md#lid-fit")
BOARD_WIDTH   = checklib.measured(24.6, "ref/measurements.md#board", "caliper, 3 samples")
LIP_LENGTH    = checklib.derived(LENGTH - 2 * WALL - 2 * LIP_CLEARANCE,
                                 "cavity less the clearance on both sides")
SHRINK_ALLOW  = checklib.estimated(0.15, "PETG shrink, not measured on this printer")
```

**И это обязательно, с первого дня и без промежуточных режимов.** Правило, которое
гейт применяет:

> Каждое имя уровня модуля в `model.py`, написанное в UPPER_SNAKE и связанное с
> `float`, обязано быть `checklib.Number`. Голый `float` — отказ сборки.

Граница выбрана так, чтобы быть РАЗРЕШИМОЙ и при этом попадать ровно в те числа, о
которых весь пункт:

* **UPPER_SNAKE** — так константы пишет шаблон (`model_template/model.py:44-73`), то
  есть та самая форма, которой учится каждый новый проект; и это отсекает
  `from math import pi` и прочие импортированные имена, про которые сборка не может
  знать, что они не свои;
* **`float`, а не `int`** — целое в CAD-модели это счётчик, номер или флаг
  (`ANGLES = 24`, `MIN_STL_BYTES = 1024`); дробное — это миллиметр, допуск или посадка,
  то есть ровно то, что обязано иметь источник. Число, которое дробное по случайности,
  честно пишется `derived(0.5, "half, exactly")` — и это одна строчка, а не спор;
* **тот же набор, который обходит `collect()`** — глобали плюс один уровень внутрь
  словаря, списка и кортежа. Определение одно, и обход, и правило читают его из одного
  места.

Требование не «измерь всё». `estimated(value, note)` собирается всегда и стоит одной
честной фразы; отказ включается только на числе, о котором не сказано НИЧЕГО. Именно
такое число стоило двух печатей.

### Сигнатура и форма

В `src/cadbuild/checklib.py` (то есть в имени, которое модель уже импортирует):

```python
class Number(float):
    """A float that remembers where its value came from.

    A subclass of float, so it goes into cadquery arithmetic, into f-strings and
    into json exactly like the number it is -- a model that wraps a constant
    changes nothing about how the geometry is built.

    PROVENANCE DOES NOT PROPAGATE THROUGH ARITHMETIC, on purpose: `a * 2` is a
    plain float. A number worked out from other numbers has to say so with
    `derived()`, which is a sentence about WHICH numbers, and a rule that
    inferred it would be inventing that sentence.
    """
    __slots__ = ("kind", "source", "note")


def measured(value, source, note=""):
    """A number somebody measured. `source` points at where it is written down:
    "ref/measurements.md#lid-fit" -- a file in the project, and optionally the
    heading inside it. The build CHECKS that both exist."""


def derived(value, note):
    """A number worked out from other numbers. `note` says from which."""


def estimated(value, note):
    """A number nobody measured. It builds, and the build says so out loud, in
    the log and in metrics.json. `note` says what would settle it."""
```

Проверяющая половина — новый модуль `src/cadbuild/provenance.py` (сборочная сторона, в
`checklib` ей не место: `checklib` не ходит в файловую систему и не знает про
`project_root`):

```python
SOURCE_FILE_MAX_BYTES = 1 << 20   # a measurement journal is text; a megabyte is
                                  # already a hundred times more than any of them

def collect(model):
    """Every `Number` reachable in the model's globals, with the name it is bound to.

    A shallow walk of `vars(model)`, plus one level into dict, list and tuple
    values -- a table of clearances is an ordinary way to hold them. Deeper than
    that is not walked and is documented as not walked, because a walk that
    follows arbitrary objects is a walk into a CAD kernel.
    """


def unwrapped(model):
    """Every module-level UPPER_SNAKE name bound to a PLAIN float, with its line.

    The other half of collect(), over exactly the same walk, so the inventory
    and the rule can never disagree about what they are looking at. `int` is a
    count or a flag, not a dimension, and is not looked at.
    """


def check(entries, bare, root):
    """Resolve every `measured()` source; refuse every undeclared number.

    ONE error listing every failure of both kinds, not one per build: the author
    fixes a journal once, not four times, and declares five constants in one
    pass rather than in five red builds.
    """


def report(entries):
    """Print the estimates. Returns the summary for metrics.json."""
```

Формат `source`: `"<relative path>[#<anchor>]"`. Правила разрешения:

* путь относительный, разбирается покомпонентно, любой `..`, абсолютный путь или символ
  вне `[A-Za-z0-9._-]` — отказ. Тот же алфавит, что у пуша (`SAFE_COMPONENT`), и по той
  же причине: это имя, которое пришло из недоверенного дерева;
* файл должен существовать под `project_root()` и читаться как UTF-8, не длиннее
  `SOURCE_FILE_MAX_BYTES`;
* если якорь задан — в файле должен быть markdown-заголовок, слаг которого равен якорю.
  Слаг: в нижний регистр, всё не-буквенно-цифровое → `-`, схлопнуть повторы, обрезать
  по краям. `## Lid fit` → `lid-fit`;
* якорь не задан — проверяется только существование файла.

### Края и отказы

* **`measured()`, файла нет / якоря нет** — `BuildError`. Это не суровость, это весь
  смысл пункта: `# measured fit on the printer` без измерения — то, что стоило двух
  печатей. Текст ошибки обязан предложить оба выхода: записать измерение в журнал или
  понизить число до `estimated()`.
* **`estimated()`** — строка в лог с префиксом `estimate:` (НЕ `warning:` — иначе тест
  шаблона запретит шаблону нести честную оценку, а он должен её нести, см. пункт 5) плюс
  запись в `metrics.json`. Сборка идёт.
* **`derived()`** — ничего не проверяется, `note` попадает в `metrics.json`. Проверить
  вывод машинно нельзя, а требовать формулу — значит требовать второй копии выражения,
  которое стоит строчкой выше.
* **Число не обёрнуто вообще** — `BuildError`, со всеми нарушителями в одном сообщении и
  с их номерами строк: гонять сборку по одному имени за раз — это тот же ад, что и
  падение на первом неразрешённом источнике. Текст ошибки обязан показать все три выхода
  на конкретном имени из этого же файла, включая `estimated(value, "…")`, который
  собирается всегда. Никакой эвристики «это похоже на зазор» здесь нет и не появится:
  правило смотрит на РЕГИСТР ИМЕНИ и ТИП значения, а не на смысл, поэтому оно
  разрешимо и одинаково для всех.
* **`Number` внутри `metrics.json`** — `write_metrics` уже приводит `float` через
  `round(value, 6)`, что возвращает обычный `float`; `json.dumps` подавится подклассом
  только если у него нестандартный `__repr__`, чего у нас нет. Всё же положи тест: строка
  `isinstance(value, float)` в `write_metrics.trim` (`metrics.py:181-182`) стоит РАНЬШЕ
  проверки на `bool`, и порядок там неслучайный.
* **`Number` с `nan`/`inf`** — `ValueError` в конструкторе. Число, которое нельзя
  сравнить, не измерение.
* **Одно и то же имя-источник у пяти констант** — нормально и никак не отмечается: пять
  измерений в одном журнале под одним заголовком бывают.

* **Место вызова** — сразу после `load_model()` в `build.py:22`, до геометрии. Это
  правило об ИСХОДНИКЕ, и оно попадает в ту же категорию, что имена и виды, — «всё, что
  может быть не так до того, как существует хоть один треугольник, в порядке возрастания
  цены» (комментарий `build.py:30-38`). Отказ за необёрнутое число обязан звучать оттуда
  же и до первой секунды, потраченной на геометрию.

### Тесты

`tests/cadbuild/test_provenance.py` — новый файл, без CAD-ядра целиком:

* `measured(0.25, ...)` равен `0.25`, `float(x) == 0.25`, арифметика возвращает обычный
  `float` и провенанс НЕ наследуется (тест фиксирует принятое решение);
* `nan`/`inf` отвергаются;
* `collect` находит константу в глобалях, в значении словаря и в элементе списка; НЕ
  ходит внутрь произвольного объекта;
* разрешение источника: файл есть/нет, якорь есть/нет, слаг заголовка совпадает,
  `..` и абсолютный путь отвергнуты, файл больше потолка отвергнут;
* `check` собирает ВСЕ неразрешённые источники в одно сообщение, а не падает на первом;
* `report` печатает каждую оценку с префиксом `estimate:` и ни одной строки `warning:`;
* сводка для `metrics.json` имеет ровно ту форму, которую читает `metricsdiff`
  (см. пункт 6), — тест на форму, а не на содержание;
* обязательность: `GAP = 0.2` голым числом даёт `BuildError`; `GAP =
  estimated(0.2, "...")` собирается; три голых числа перечислены в ОДНОМ сообщении, все
  три с номерами строк;
* границы правила проверены каждая по отдельности: `ANGLES = 24` (int) проходит,
  `gap = 0.2` (нижний регистр) проходит, `from math import pi` проходит, `SIZES =
  [10.0, 20.0]` с голыми числами внутри — отказ, `SIZES = [measured(10.0, "..."),
  ...]` — проходит;
* модель без единого дробного UPPER_SNAKE собирается, даёт нулевую сводку и молчание.

---

## 5. Шаблон `/start/template.tar.gz`

### Сейчас

`model_template/model.py` — двухдетальная коробка, 275 строк, плюс `.gitignore`. Она
собирается как есть; `tests/test_template.py` прогоняет её через `run_build` — тот же
вход, что у пуша, — и требует нулевых `warning:` и напечатанного ЧИСЛА проверок.

Шаблон — единственный канал, которым конвенция доезжает до нового проекта: `hammerola
create` распаковывает его, `/start/template.tar.gz` раздаёт байты, а `skill/SKILL.md`
для контракта отсылает СЮДА, вместо того чтобы его пересказывать. И он учит только тем,
что собирается: абзац текста в нём сгниёт молча, работающий пример — нет.

Чего в нём нет: каталога `ref/`, мока покупного железа, примера числа с источником и
различения «сколько места есть» против «сколько нужно».

### Нужно

Четыре добавления, каждое — работающим примером.

**1. `model_template/ref/measurements.md`** — журнал сырых измерений. Формат
диктуется тем, что его читает проверка провенанса: заголовок второго уровня, чей слаг
и есть якорь; под ним — строки «дата | что мерили | чем | число».

```markdown
# Measurements

Raw numbers, as they came off the instrument. One heading per thing measured; the
constants in model.py point at these headings by name
(`checklib.measured(24.6, "ref/measurements.md#board")`), and the build REFUSES
to publish if a heading a constant claims is not here.

Write the number you read, not the number you wanted. A measurement corrected
later gets a new line under the same heading, with its own date -- the old line
stays, because "it used to measure 24.4" is the thing you will want to know.

## board

| date       | what                          | instrument      | value   |
| ---------- | ----------------------------- | --------------- | ------- |
| 2026-08-24 | bought module, width, 3 spots | caliper 0.02 mm | 24.6 mm |
| 2026-08-24 | bought module, height         | caliper 0.02 mm | 12.1 mm |

## lid-fit

| date       | what                             | instrument      | value   |
| ---------- | -------------------------------- | --------------- | ------- |
| 2026-08-24 | printed lid lip, across the flats | caliper 0.02 mm | 34.7 mm |
```

**2. `model_template/mocks.py`** — заготовка под покупное железо, отдельным файлом,
потому что `import mocks` — это конвенция, которую механика уже поддерживает
(`geometry.load_model`
объясняет, почему корень проекта идёт первым в `sys.path`: именно чтобы `import mocks`
находил `mocks.py` проекта). Мок — коробка с размерами из журнала:

```python
"""Mock-ups of hardware nobody prints: the shapes the design has to make room for.

A mock is scenery. It is NOT in printables(), it is grey in every picture
(the palette colours what is printed and greys everything else), and its
dimensions come from `ref/measurements.md` like every other number that came off
a real object.

NAME A MOCK WITHOUT THE WORD OF THE PART IT STANDS BESIDE. The coverage gate
matches on whole words, so an object called "lid mock" answers for the printable
`lid` and a build can certify a part nobody can see. "bought module" answers for
nothing.
"""
```

**3. Пример проверки с провенансом.** В `model.py`:

```python
# What the box has to hold. MEASURED, and the build refuses to publish if the
# heading these point at is not in ref/measurements.md -- which is the whole
# difference between a measurement and a comment saying "measured".
BOARD_WIDTH_NEEDED  = checklib.measured(24.6, "ref/measurements.md#board")
BOARD_HEIGHT_NEEDED = checklib.measured(12.1, "ref/measurements.md#board")

# NOT measured, and the build says so on every run. This is the line to replace
# with a measurement before anything is printed twice: a clearance guessed at is
# the number that cost two prints and 100 g of filament on the project this
# template learned from.
BOARD_CLEARANCE = checklib.estimated(
    0.4, "guessed; measure a printed pocket against the real module and record it")
```

и в `checks()` — проверка, читающая ГЕОМЕТРИЮ, а не повторяющая арифметику:

```python
    # The cavity that came out has to hold what it is for. Both sides are read
    # off the finished solid and off the mock -- not off the constants that drove
    # them, which is the difference between a check and a restatement.
    cavity = ...            # inner wire of the rim face, as in check 1
    module = mocks.bought_module().val().BoundingBox()
    for axis, available, needed in (
            ("X", cavity.xlen, module.xlen + 2 * BOARD_CLEARANCE),
            ("Y", cavity.ylen, module.ylen + 2 * BOARD_CLEARANCE)):
        assert needed <= available, (
            f"the cavity is {available:.2f} mm along {axis} and the module needs "
            f"{needed:.2f} mm with its clearance")
```

**4. Различение «сколько есть» против «сколько нужно» — в именах.** Суффиксы
`_AVAILABLE` и `_NEEDED`, и один рабочий абзац в докстринге секции параметров:

```python
# TWO KINDS OF NUMBER LIVE HERE AND THEY ARE NOT THE SAME KIND. A `*_AVAILABLE`
# is room that exists -- the inside of a cavity, the length of a shelf, the
# travel of a hinge. A `*_NEEDED` is what something demands of that room -- a
# bought module plus its clearance, a screw plus its driver. Confusing the two
# is how a pocket comes out exactly the size of the thing that has to slide into
# it. The check is always the same sentence: `assert needed <= available`, with
# both sides read off the geometry rather than off these lines.
```

Плюс: `checks()` шаблона зовёт ОДНУ из новых проверок пункта 2 — `unsupported_area` на
крышке — с явным бюджетом и комментарием, откуда бюджет взялся. Это единственное место,
где новая функция получает работающий пример, а без примера её не позовёт никто.

### Края и отказы

* **Шаблон обязан собираться и оставаться без `warning:`.** Строка `estimate:` — не
  предупреждение, и это специально: шаблон должен нести честную оценку и показывать, что
  сборка её называет.
* **Пути.** `ref/measurements.md` — два компонента, оба проходят `SAFE_COMPONENT`
  (первый символ буквенно-цифровой), глубина 2 при потолке `MAX_PATH_DEPTH = 8`. И для
  спуска (`TEMPLATE_RULES`, `src/client/unpack.py:85`), и для подъёма
  (`pack.py` роняет только скрытое, `__pycache__`, `out`, `_out`, `build`, `dist`).
  `.md` в пуше — обычный файл, алфавит расширений не ограничивает.
* **`mocks.py` в корне** попадает в `source_fingerprints` (`metrics.py:143` — glob
  `*.py` по корню проекта). Это правильно: мок — часть модели, и его правка обязана
  двигать хеш кода.
* **Мок не должен покрывать печатаемую деталь по имени.** Гейт покрытия
  (`gate.check_printables_shown`) предупреждает, когда деталь «сопоставлена только по
  имени». Имя `bought module` не содержит ни `base`, ни `lid`; тест шаблона на нулевые
  предупреждения это и сторожит.
* **Шаблон растёт.** Сегодня 12 КБ, станет ~18 КБ. Потолки (`MAX_MEMBERS = 1024`,
  `MAX_BUILD_BYTES = 64 MiB`) не рядом. Но растёт и время чтения: держи новую геометрию
  минимальной — карман под мок делается одним `.rect().cutBlind()`, а не вторым видом и
  не третьей деталью.
* **Согласие со скиллом.** `skill/SKILL.md` отсылает за контрактом сюда, и
  `tests/test_onboarding.py` держит согласие между списком разрешённых импортов в шаблоне
  и в скилле. Если шаблон начнёт импортировать что-то новое — а он не начнёт, `mocks` это
  его собственный файл, — проверь этот тест.

### Тесты

`tests/test_template.py` (существующий файл):

* `test_the_model_defines_the_contract_it_is_the_example_of` дополняется: `mocks` среди
  импортов, `measured` и `estimated` встречаются в исходнике;
* новый тест без ядра: `ref/measurements.md` существует, и КАЖДЫЙ якорь, на который
  ссылается `model.py`, находится в нём как заголовок. Разбирается AST-ом и регулярным
  выражением по строке-источнику — то есть тот же вопрос, что задаёт сборка, но задан на
  каждом пуше, а не только там, где есть CAD-ядро (сборочный тест в CI пропускается);
* `EXPECTED_ARTEFACTS` — из пункта 1;
* сборочный тест дополняется проверкой, что в логе есть строка `estimate:` и что она
  называет `BOARD_CLEARANCE`: шаблон обязан демонстрировать, что оценка слышна;
* сборочный тест продолжает требовать нулевых `warning:` и напечатанного числа проверок.

`tests/test_onboarding.py`: архив, который отдаёт хаб, по-прежнему побайтово равен
каталогу на диске (существующий тест это уже делает — просто убедись, что подкаталог
`ref/` он переживает; `template_members` ходит `rglob`-ом, так что переживёт).

---

## 6. Физические числа для `hammerola diff`

### Сейчас

`collect_metrics` (`metrics.py:161-173`) собирает:

```python
    return {
        "version": METRICS_VERSION,
        "project": project,
        "built": ...,
        "source": source_fingerprints(),
        "parts": parts,          # per part, from export_printables
        "assembly": {"interference_mm3": checklib.recorded_interference()},
        "checks_passed": checks_passed,
    }
```

Подетальные числа приходят из `printables.export_printables` (`printables.py:107-114` и
161-162): `volume_mm3`, `bbox_mm`, `faces`, `edges`, `solids`, `triangles`, `watertight`.
Сравнивает их `src/metricsdiff.py`, поле за полем, по списку
`METRIC_FIELDS` (`metricsdiff.py:43-44`). Этот же модуль читает `hammerola diff`
(`src/client/revdiff.py`), и он единственный на обе стороны — копии здесь запрещены и
это записано.

Чего не хватает, чтобы механически ответить «изменил ли этот круг правок хоть одно
физическое число»: **габарита сборки, объёма материала, площади прилипания, свесов,
габарита плиты и зазоров**. Сегодня можно узнать, что деталь стала на 3.5% меньше по
объёму, — и нельзя узнать, что она перестала доставать до стола, что свес вырос вдвое
или что зазор в паре сжался до нуля. В разборе три круга правок дали изменение ровно
одного параметра, а остальное было полировкой скрипта, — и увидеть это было нечем.

### Нужно

**Подетально** (считается в `export_printables`, из меша, который там уже загружен на
строке 139 — то есть даром):

* `first_layer_mm2` — площадь прилипания: сумма площадей треугольников, чья нормаль
  смотрит строго вниз и чья высота лежит в пределах `FIRST_LAYER_TOL` от нижней точки
  меша;
* `overhang_mm2` — сумма площадей треугольников с нормалью ниже `-cos(45°)`, за вычетом
  тех, что уже засчитаны первым слоем. Это МЕТРИКА, а не проверка: она не спрашивает,
  есть ли опора, поэтому стоит один проход numpy по массиву нормалей. Проверку со
  стрельбой лучами делает `checklib.unsupported_area` из пункта 2 — она отвечает на
  вопрос «выдержит ли»; метрика отвечает на вопрос «сдвинулось ли», и это разные вопросы
  с разной ценой.

**По сборке** (в `assembly.export_assembled` и `export_print_plate` из пункта 1, ДО
экспорта — после экспорта габарит меряется по мешу, `printables.py:101-106`):

* `assembly.bbox_mm` — габарит изделия;
* `assembly.volume_mm3` — сумма объёмов печатаемых деталей (складывается в
  `collect_metrics` из уже измеренного, второго измерения не нужно);
* `assembly.print_bbox_mm` — габарит плиты: «влезает ли ещё в стол»;
* `assembly.clearance` — из `checklib.recorded_clearance()` (пункт 2);
* `assembly.interference_mm3` — как было.

**Сверху:**

* `checks_static` (пункт 3);
* `provenance` (пункт 4): `{"measured": n, "derived": n, "estimated": [{"name",
  "value", "note"}]}`.

### Сигнатура и форма

`src/metricsdiff.py` — только стандартная библиотека, это правило и его держит тест
(`tests/test_metricsdiff.py`):

```python
METRIC_FIELDS = ("volume_mm3", "bbox_mm", "first_layer_mm2", "overhang_mm2",
                 "faces", "edges", "solids", "triangles", "watertight")

# What is compared about the assembly as a whole. A separate tuple from
# METRIC_FIELDS because these live under a different key and are not per part.
ASSEMBLY_FIELDS = ("bbox_mm", "print_bbox_mm", "volume_mm3")

# The fields that are about the PHYSICAL OBJECT rather than about the model
# source or the mesh it was tessellated into. `hammerola diff --json` answers
# "did this round of edits change anything physical" out of exactly these, which
# is why they are named once, here, instead of being a judgement each reader
# makes.
PHYSICAL_FIELDS = ("volume_mm3", "bbox_mm", "first_layer_mm2", "overhang_mm2")


def moved_fields(old, new):
    """Structured answer: what moved, by part and by field. `metrics_diff` is the
    same walk formatted for a person; this one is for a machine."""
```

`_shown` (`metricsdiff.py:58-68`) получает ветку для `*_mm2` (`f"{value:.1f} mm2"`) и
для `print_bbox_mm` (та же форма, что `bbox_mm`). `_field_moved` — процент для площадей,
как для объёма: «прилипание 640 → 210 мм² (−67%)» — это ровно та строка, ради которой
всё делается.

`metrics_diff` дополняется двумя блоками — по `ASSEMBLY_FIELDS` и по
`assembly.clearance` (появился зазор / пропал / сдвинулся), в том же стиле, что уже
написан для `interference_mm3` (`metricsdiff.py:124-133`). `metrics_summary` — тем же.

`hammerola diff` получает флаг `--json`, печатающий `{"moved": [...], "compared": n}` из
`moved_fields`, ограниченный `PHYSICAL_FIELDS`. Это и есть механический ответ на вопрос
«изменил ли круг правок хоть одно физическое число»: пустой `moved` — не изменил. Кодов
возврата не трогаем: `hammerola diff` возвращает 0, на это могут быть завязаны чужие
скрипты, и менять это ради удобства нельзя.

`_print_geometry` (`src/client/revdiff.py:82-95`) в ветке «ничего не сдвинулось»
начинает называть, СКОЛЬКО чисел сравнено: «every measured number is the same (17
compared)». Разница между «ничего не изменилось» и «сравнивать было нечего» — это
буквально разница между ответом и его отсутствием.

### Края и отказы

* **`METRICS_VERSION` НЕ бумпится.** Правило (`metrics.py:84`): версия растёт, «когда
  читатель старого файла прочтёт его неправильно». Новые поля не меняют смысла старых, а
  `metrics_diff` сравнивает только те поля, которые есть с обеих сторон
  (`metricsdiff.py:117-120`). Старый `metrics.json` против нового даст diff по общим
  полям и молчание по новым — что и требуется. Оставь `METRICS_VERSION = 1` и объясни
  это в комментарии, иначе следующий читатель бумпнет её «на всякий случай» и сломает
  сравнение со всеми опубликованными ревизиями.
* **Старая ревизия без новых полей.** См. выше: поле, которого нет с одной стороны, не
  сравнивается. Явный тест обязателен.
* **`first_layer_mm2 == 0`.** Законно и информативно: деталь стоит на подпорках или на
  одной точке. Ноль пишется, никаких проблем не выдаётся — это метрика.
* **Меш с вырожденными треугольниками.** Тесселятор выдаёт нулевые треугольники на
  полюсах сферических граней (`preview_png.load_mesh` про это знает). Нормаль там
  неопределена; отфильтруй по площади > 0 перед суммированием, иначе получишь `nan`,
  который пролезет в JSON как `NaN` и сломает разбор у клиента.
* **`assembly.bbox_mm`, когда вида `assembled` нет.** `assembled_shape` уже
  подставляет печатаемые детали как есть (`assembly.py:44-46`) — габарит считается по
  тому же самому.
* **`clearance` пустой** (никто не звал `swept_clearance`) — ключ пишется пустым
  объектом, как сегодня пишется пустой `interference_mm3`. Отсутствие ключа и пустой
  ключ — разные вещи, и `interference_mm3` уже установил, какая из них означает «не
  измеряли».
* **`report_metrics` не имеет права уронить сборку** — это обещано в докстринге
  (`metrics.py:195-217`) и защищено одним общим `except`. Новые блоки идут ВНУТРЬ этой
  же защиты; ни один из них не смеет ходить в поле без `.get`.
* **Цена.** Все новые подетальные числа считаются из меша, который гейт грузит и так:
  один-два прохода numpy по массиву треугольников, на 200k треугольников — единицы
  миллисекунд. Габариты — по одному `BoundingBox()` на форму.
* **Порядок «измерить, потом экспортировать» обязан остаться.** Экспорт тесселирует
  форму на месте, и `BoundingBox()` после него меряет уже меш
  (`printables.py:101-106`). Если поменять местами — числа поедут на десятые доли
  миллиметра на всём, что со скруглениями, и это будет выглядеть как «геометрия
  изменилась» на первой же сборке.
* **`src/metricsdiff.py` едет в zipapp клиента** (`onboarding.CLIENT_EXTRA_MODULES`),
  так что «только stdlib» — не пожелание, а условие работоспособности `hammerola` на
  чужом ноутбуке. Никакого numpy в этом файле.

### Тесты

`tests/cadbuild/test_metrics.py` (существующий файл, `build()`/`measured()` хелперы уже
там):

* каждое новое подетальное поле сравнивается и печатается в человеческих единицах;
* площадь прилипания, упавшая вдвое, даёт строку с процентом;
* блок по сборке: сдвинувшийся `bbox_mm`, сдвинувшийся `print_bbox_mm`, появившийся и
  исчезнувший зазор;
* `checks_static` и `provenance` попадают в `metrics.json` и в сводку;
* **старый `metrics.json` без новых полей против нового** — diff содержит только общие
  поля и не падает. Этот тест важнее остальных: он про то, что выкат не сломает
  сравнение с уже опубликованным.

`tests/test_metricsdiff.py`: `moved_fields` возвращает пустое, когда физического
движения нет, и называет поле и деталь, когда есть; обе половины по-прежнему держат
ОДНИ И ТЕ ЖЕ объекты (`is`, не `==`) — существующий тест, не сломай его новым импортом;
модуль по-прежнему импортирует только стандартную библиотеку.

`tests/client/`: `hammerola diff --json` печатает разбираемый JSON и возвращает 0 и
когда что-то сдвинулось, и когда нет.

---

## 6.1 Сводка не печатается никогда: `report_metrics` мёртв

Отдельный подпункт, потому что это не новое поле, а не подключённый провод: вся вторая
половина пункта 6 («сборка сама говорит, что сдвинулось») уже написана, задокументирована
в трёх местах и не вызывается ни разу.

### Сейчас

`src/cadbuild/metrics.py:195` определяет `report_metrics(out_dir, baseline, why)` —
«Print what moved since the `dev` build». **У неё нет ни одного вызова.**
`grep -rn 'report_metrics' --include='*.py' .` по всему дереву даёт четыре попадания и ни
одного вызова: определение (`metrics.py:195`), строка в `__all__` (`metrics.py:68`) и две
ссылки в тексте докстрингов (`metrics.py:13`, `tests/test_metricsdiff.py:53`). Из
`build.py:84` зовётся только `write_metrics`:

```python
    # Written after the checks, because it carries what they measured and how
    # many of them there were.
    write_metrics(out_dir, collect_metrics(project, part_metrics, checks_passed))
```

`fetch_baseline`, на которую ссылается сама `report_metrics`, **в коде не существует
вообще** — ни в сборочной половине, ни в клиенте. Два упоминания, оба в прозе:

* `metrics.py:9-13` — «TWO FUNCTIONS OF THIS MODULE STAYED ON THE CLIENT SIDE and are
  deliberately not here: `fetch_baseline`, which GET's the previous metrics.json off
  `{hub}/project/<pid>/dev/`… Inside the hub the first is a file on the volume rather
  than a request (whatever reads it will pass it to report_metrics below, which already
  takes the baseline as an argument)». «Whatever reads it» — не читает никто;
* `metrics.py:199` — «fetch_baseline settles two things about what came off the wire».

Ещё три докстринга обещают работающий контур:

* `metrics.py:92-95` — «It rides in the archive, so the NEXT build of the same project
  can fetch it back from `dev` and say what moved -- which is the only form of "did that
  edit do what I meant" that does not involve opening two viewers side by side»;
* `build.py:86-88` — «it is written for the next build of this project to read back off
  `dev`»;
* `src/client/revdiff.py:12` — «the same function the build itself prints after every
  run». Сборка её не печатает ни разу.

`tests/test_metricsdiff.py:53` в докстринге теста пишет «`src/cadbuild/metrics.
report_metrics` calls it to print what moved since `dev`». Сам тест проверяет
тождественность объектов и он честный; неверна фраза о вызове.

**Правка этих пяти мест — часть работы, а не косметика.** Докстринг, описывающий
несуществующий контур, дороже отсутствующего: читатель кода ищет вызов, не находит,
решает, что плохо искал, и идёт искать второй раз. Именно так эта дыра и прожила до сих
пор — она описана слишком уверенно, чтобы её заподозрить.

Цена дыры: в ЛОГ сборки не возвращается ни одного размера. Картинки лежат по своим URL
(раздел 0), но их надо знать по имени и за ними надо сходить; лог же приходит сам, и
единственная строка про деталь в нём — та, что печатает `printables.py:158-159`:

```python
        print(f"  {name}: valid, volume {volume / 1000.0:.2f} cm3, watertight, "
              f"one body, {mesh.faces.shape[0]} faces")
```

Объём и число граней. Ни габарита, ни площади прилипания, ни свесов, ни одного слова о
том, что изменилось с прошлого раза.

### Нужно

**Сборка на каждом прогоне печатает свои физические числа, а когда есть с чем сравнивать
— что сдвинулось.** Три требования, каждое отдельно:

1. **Сводка печатается ВСЕГДА**, а не только когда сравнивать не с чем (сегодня ветка с
   `metrics_summary` живёт под `if baseline is None`). Числа лежат и в `metrics.json`, но
   за ним надо сходить, зная имя; лог приходит сам и приходит тому, кто пушил. Это
   единственный канал, который не требует второго действия, — и он не должен зависеть от
   того, была ли предыдущая сборка.
2. **Diff печатается, когда baseline есть**, и когда ничего не сдвинулось — печатается
   ровно это, с числом сравнённых чисел («every measured number is the same (17
   compared)»), а не молчание. Сегодня `if lines:` (`metrics.py:242`) молчит, и молчание
   неотличимо от «сравнение не состоялось» — та же разница, которую пункт 6 чинит в
   `revdiff._print_geometry`, и чинить её надо одинаково с обеих сторон.
3. **Сводка печатает физические поля** — `PHYSICAL_FIELDS` из пункта 6, названные там
   один раз и здесь только используемые. Число граней и треугольников в подетальной
   строке лога не нужно: это факты о меше, они остаются в `metrics.json` и в diff-е,
   где отвечают на вопрос «почему сдвинулось».

**Baseline берётся из опубликованного слота `dev` того же проекта** — файл
`<projects_dir>/<pid>/dev/metrics.json`, ровно там, откуда `store._dev_meta`
(`src/store.py:2323-2336`) читает `meta.json` того же слота. Функцию, которая его
достаёт, надо написать: её нет, и `fetch_baseline` из докстринга — не она (это HTTP-имя
из предыдущего проекта, и внутри хаба запрос за собственным файлом на собственном томе не
нужен).

**Цепочка от слота до печати — пять звеньев, все существующие**, и каждое надо тронуть
ровно один раз:

1. `Store.dev_metrics_path(pid)` — новый метод, отдаёт путь к `metrics.json` слота или
   `None`. По образцу `_dev_meta`: терпимый, ничего не бросает;
2. `jobs._build_and_publish` (`src/jobs.py:1257-1259`) спрашивает его у стора и передаёт
   в `build_arguments`. **Только через `build_arguments`** — это единственное место, где
   вызов воркера записан, и `tests/test_jobs.py:2101-2145` держит его связанным с
   сигнатурой `run_build`; аргумент, добавленный мимо, ломает продакшен на первом пуше
   при зелёном тестовом наборе (весь довод — в докстринге того теста);
3. `run_build(..., baseline=None)` **копирует** файл в свой scratch и передаёт
   `--baseline <scratch>/baseline.json`. Копия, а не путь в стор: во-первых, параллельная
   сборка того же проекта может подменить слот посреди этой (`_swap_dev_slot` — два
   `rename`), и тогда сравнение окажется с чем-то третьим; во-вторых, scratch — это
   каталог родителя, куда уже кладётся `result.json`, и другого канала «родитель дал
   ребёнку файл» здесь нет;
4. `child.main` разбирает `--baseline` (новая строка в `_OPTIONS`,
   `src/buildproc/child.py:73-80`) и передаёт путь в `build()`;
5. `build(out_dir, preview_mode="iso", baseline=None)` — **последней строкой перед
   формированием `files`** зовёт `read_baseline` и `report_metrics`. Вызов сидит в
   `build()`, а не в `child.py`, по двум причинам: сводка — часть сборки, и её видит
   любой, кто зовёт `build()`; и вызов из `build()` можно удержать тестом (см. «Тесты»),
   а вызов из `main()` ребёнка — нет, там тест потребовал бы CAD-ядра.

**Печать обязана быть невозможной причиной отказа сборки.** Требование дословно по
смыслу то же, что уже написано в докстринге `report_metrics` (`metrics.py:198-216`), и
переписывать его не надо — надо его СОХРАНИТЬ при правке функции:

* вся сверка сидит под ОДНИМ guard-ом, а не каждое поле под своим: «the failures are not
  a list to enumerate, they are every way a dict of unknown shape can be walked»;
* строки собираются ДО печати, чтобы ошибка форматирования случилась до того, как
  что-то попало в терминал, а не посреди блока;
* guard покрывает и `unchanged_code_moved_geometry`, которая ходит по тем же двум
  словарям.

Новая сводка добавляется внутрь той же защиты и по тем же правилам: сначала строки
сводки, потом строки diff-а, потом одна печать.

### Сигнатура и форма

В `src/cadbuild/metrics.py`:

```python
def read_baseline(path):
    """The published `dev` metrics.json to compare against, and why not.

    Returns `(baseline, why)`: a dict this build knows how to read, or None
    with one clause saying what was wrong with it. Never raises -- everything
    it can be handed is a file somebody else published, and the caller's
    promise is that a diff cannot fail a build.

    What it settles is deliberately only what CAN be settled cheaply: the file
    parses, it is an object, and its `version` is one this build knows.
    Nothing about what is inside it -- `{"version": 1, "parts": {"body": 42}}`
    passes all three and is a TypeError in the middle of the comparison, which
    is why report_metrics keeps its guard.
    """
```

`why` — законченное придаточное без точки, оно подставляется в существующую строку
`f"metrics: nothing to compare against -- {why}. This build:"`:

* `"this project has no dev build yet"`;
* `"the dev build published no metrics.json"`;
* `"the metrics.json published as dev is not readable"` — `OSError`, не UTF-8, не JSON,
  не объект;
* `f"the metrics.json published as dev is version {n}, this build writes version
  {METRICS_VERSION}"` — то самое поведение, которое обещает комментарий у
  `METRICS_VERSION` (`metrics.py:79-83`): «A build refuses to compare against a version
  it does not know and says so».

В `src/metricsdiff.py` — параметр вместо второго списка полей:

```python
def _part_summary(part, fields=METRIC_FIELDS): ...
def metrics_summary(metrics, fields=METRIC_FIELDS): ...
```

`report_metrics` зовёт `metrics_summary(current, fields=PHYSICAL_FIELDS)`, и имя
аргумента в месте вызова — это и есть объяснение, почему в логе не все поля. Умолчание не
меняется, поэтому «new part» и «gone» внутри `metrics_diff` (`metricsdiff.py:112-115`)
по-прежнему печатают про деталь всё: деталь, которой раньше не было, описывают целиком.

В `src/store.py`:

```python
def dev_metrics_path(self, pid: str) -> Path | None:
    """The local slot's metrics.json, or None when there is nothing there.

    A path rather than the parsed file: the only caller hands it to a build
    process, and parsing it here would mean two readers of the same file
    disagreeing about what a broken one is. Tolerant like `_dev_meta` next to
    it -- an unreadable slot is a missing baseline, never an exception on the
    publish path.
    """
```

Форма лога (обе ветки, `N` — число сравнённых чисел):

```
metrics: nothing to compare against -- this project has no dev build yet. This build:
  base: volume 33.06 cm3, bbox 120.00x80.00x24.00 mm, first layer 640.2 mm2, overhang 12.0 mm2
  lid: volume 11.20 cm3, bbox 120.00x80.00x6.00 mm, first layer 960.0 mm2, overhang 0.0 mm2
  assembly: bbox 120.00x80.00x30.00 mm, plate 220.00x110.00x6.00 mm

metrics vs dev:
  base: volume 33.06 -> 31.90 cm3 (-3.5%), first layer 640.2 -> 210.4 mm2 (-67%)
```

### Края и отказы

* **Слота `dev` нет** (первая сборка проекта), **слот есть, а `metrics.json` в нём нет**
  (сборка старше этой работы), **файл не читается / не JSON / не объект**, **версия
  незнакомая**, **объект правильной формы с мусором внутри** — во всех пяти случаях
  сборка публикуется, а в лог идёт ОДНА строка с причиной. Пятый случай ловит
  существующий guard и печатает свою готовую строку («…is not shaped like one, so there
  is nothing to compare against»); остальные четыре разбирает `read_baseline`.
* **Копия не сделалась** (`OSError` при `shutil.copyfile` в scratch) — родитель зовёт
  ребёнка без `--baseline`, и это ветка «сравнивать не с чем» с причиной. Сборку это
  уронить не может по определению: копия делается до запуска ребёнка, в родителе, где
  падение уже обработано `_build_and_publish`.
* **Коммитная сборка сравнивается с `dev`.** Слот `dev` — единственный baseline, который
  у хаба вообще есть без выбора ревизии, и он может быть старше или вообще из другой
  работы. Поэтому строка заголовка обязана называть, с чем сравнивали (`metrics vs dev:`
  — уже так и написано, `metrics.py:243`), а не «vs previous».
* **Ребёнок может переписать свой baseline.** Модель знает `sys.argv` и живёт в том же
  процессе (`child.py:30-44`). Из этого не следует ничего для хаба и следует одно для
  следующего читателя: **напечатанный diff — не доказательство**, публикация по-прежнему
  идёт по проверенному родителем списку файлов, и завязывать на текст лога решение хаба
  нельзя. Одна фраза об этом в докстринге — вся необходимая работа.
* **Своя же сборка перезапишет слот, из которого читала.** Порядок правильный сам собой:
  родитель снимает копию перед запуском ребёнка, публикация идёт после
  (`_build_and_publish`), так что сборка `dev` сравнивается с предыдущей `dev`, а не
  сама с собой. Это надо записать комментарием там, где делается копия, — порядок здесь
  и есть корректность.
* **Лог `dev`-сборки не сохраняется.** `jobs._keep_the_code` (`src/jobs.py:1374-1375`)
  для `DEV_LINK` выходит сразу, поэтому лог `dev`-пуша не ложится рядом с исходниками,
  как ложится лог коммитной сборки. Сводка на `dev` живёт только в выводе задания — том,
  что пушер читает по опросу job-а. Это нормально и менять не надо, но это причина, по
  которой сводка обязана быть КОРОТКОЙ: её не перечитают потом.
* **Объём лога.** Сводка — строка на деталь плюс строка на сборку; diff — столько строк,
  сколько полей сдвинулось. На двадцатидетальной модели это два десятка строк при
  `MAX_LOG_BYTES`, рассчитанном на порядки больше. Ограничение по физическим полям
  держит подетальную строку в одну ширину терминала — это и есть довод за него, помимо
  того, что в логе нужны миллиметры, а не треугольники.

### Тесты

`tests/cadbuild/test_build.py` (или туда, где уже стоит фейковый `build()`):

* **вызов `report_metrics` из `build()` держится тестом.** Это главный тест подпункта:
  функция уже была написана, задокументирована и осиротела ровно потому, что вызов
  ничем не держался. Проверять надо ФАКТ вызова из `build()` (подменённая
  `report_metrics` записала, что её позвали, и получила тот же `out_dir`), а не то, что
  в логе есть какая-то строка: строку можно случайно напечатать откуда угодно, а вызов —
  это то, что сломалось.

`tests/cadbuild/test_metrics.py`:

* `read_baseline` на каждом из четырёх отказов возвращает `(None, why)` с непустым `why`
  и НЕ бросает: файла нет, файл — не JSON, файл — список, версия 999;
* мусор в baseline правильной формы (`{"version": 1, "parts": {"body": 42}}`) не роняет
  `report_metrics` и печатает строку про «не той формы» — тест на то самое обещание из
  докстринга;
* сводка печатается и когда baseline есть, и когда его нет;
* baseline, совпадающий с текущим, даёт строку «every measured number is the same» с
  числом, а не пустой вывод;
* сводка содержит габарит и не содержит числа треугольников (то есть `PHYSICAL_FIELDS`
  реально применён).

`tests/test_jobs.py`:

* существующий `build_arguments`-тест (строки 2101-2145) дополняется новым аргументом —
  включая явную перепроверку в конце (строка 2145), которая перечисляет аргументы
  руками; забыть её — значит оставить тест зелёным и не проверяющим новое звено;
* `dev_metrics_path` пустого проекта — `None`, и сборка с `None` доезжает до публикации.

`tests/test_dev_builds.py` (файла `test_store.py` в наборе нет; про слот `dev` тесты
живут здесь): `dev_metrics_path` отдаёт путь после `publish_dev_built` и `None` для
неизвестного `pid`.

---

## Порядок выполнения

Семь коммитов, в этом порядке. Порядок продиктован зависимостями по данным и тем, что
каждый следующий шаг проверяется предыдущим.

**1. Пункт 1 — рендер вида `print`.** Ни от чего не зависит и даёт самую большую отдачу
на единицу работы: появляется картинка, которой сегодня не существует, — стол в
ориентации печати. Плюс он первым трогает `files`, `downloads` и резервирование стемов —
то есть первым проходит через хаб, `render.py` и клиента, и все последующие изменения
формата встречают уже поправленный путь.

**2. Пункт 4 — провенанс.** Раньше пункта 2, хотя выглядит наоборот. Причина:
проверки печатаемости из пункта 2 требуют от автора чисел — бюджета неподдержанной
площади, минимальной толщины, диаметра инструмента, — и эти числа обязаны сразу
рождаться с источником. Сделав пункт 2 первым, ты получишь `checks()`, полный новых
голых констант, которые правило потом отвергнет, и будешь возвращаться в те же файлы.
Кроме того, `Number` — это подкласс `float`, который трогает `write_metrics`; лучше
выяснить это на пустом месте, а не посреди четырёх новых проверок.

Правило обязательное, поэтому в ЭТОМ ЖЕ коммите константы `model_template/model.py`
обязаны обзавестись источником — иначе `tests/test_template.py` краснеет на первом же
прогоне. Это минимум по шаблону, не полная работа пункта 5: журнала измерений и мока в
этом коммите ещё нет, поэтому числа шаблона здесь объявляются `estimated()` и
`derived()`, а `measured()` со ссылкой на `ref/measurements.md` приходит в шаге 6
вместе с самим журналом.

**3. Пункт 2 — проверки печатаемости.** Самый большой кусок. Внутри — свой порядок, по
возрастанию риска: `swept_clearance` и `tool_access` (обе на уже существующей
механике — булевы операции и классификатор), затем `unsupported_area` (новая работа с
trimesh, но на готовом файле), затем `thin_walls` (единственная, у которой есть
предшественник, и тот провалился, — делай её последней, с прочитанным
`checklib.py:51-56` перед глазами). `swept_clearance` заводит реестр `_CLEARANCE`,
который читает пункт 6, — ещё одна причина не оставлять пункт 2 напоследок.

**4. Пункт 6 — метрики.** После пунктов 2 и 4, потому что читает их данные:
`recorded_clearance()` и сводку провенанса. После пункта 1, потому что габарит плиты
существует только там, где есть плита. Технически можно расщепить (подетальные площади
не зависят ни от чего), но расщеплять не стоит: `METRIC_FIELDS` и `metrics_summary`
трогаются один раз.

**5. Подпункт 6.1 — оживить сводку.** Сразу после пункта 6 и отдельным коммитом.
После — потому что печатает `PHYSICAL_FIELDS` и габарит сборки, то есть поля, которых до
шага 4 просто нет. Отдельным — потому что трогает совсем другие файлы: `store.py`,
`jobs.py`, `runner.py`, `child.py`, то есть путь пуша, а не геометрию. Коммит, в котором
и новые численные поля, и новое звено в цепочке запуска ребёнка, откатывается только
целиком, а откатывать эти две вещи придётся по разным причинам.

**6. Пункт 3 — статические ассерты.** После пункта 6, потому что кладёт `checks_static`
в `metrics.json` и в сводку сравнения — то есть хочет, чтобы поле было куда положить.
Отдельным коммитом, а не внутри пункта 6, потому что это единственная работа наряда,
которая живёт в AST и ни строчки не делит с геометрией: смешать её с метриками — значит
получить коммит, который нельзя откатить по одной причине.

**7. Пункт 5 — шаблон.** Строго последним, и это не «остатки»: шаблон обязан
демонстрировать ВСЁ, что появилось, и любая его правка раньше времени будет переписана.
Он же служит приёмкой всего наряда: `tests/test_template.py` прогоняет шаблон через
`run_build` — тот самый вход, которым идёт пуш, — и если шаблон, использующий
`measured()`, `unsupported_area()` и мок, собирается зелёным и без предупреждений,
значит все шесть предыдущих коммитов дружат между собой на реальном пути. Сборка
шаблона к этому моменту печатает свою сводку — а на втором прогоне и diff, — и это самая
дешёвая приёмка шага 5, какая бывает.

---

## Чего делать НЕ надо

**1. Не делать отказ сборки на тавтологическом ассерте.** Разобрано в пункте 3. Коротко:
«обе стороны — константы» не равно «тавтология», и множество законных проверок параметров
(`assert FIT_MIN < FIT_MAX`, `assert LENGTH <= BED_X`, `assert WALL >= 2 * NOZZLE`)
попадает под то же правило. Файл общий для всех проектов, ложный красный на чужой рабочей
модели дороже непечатанного числа — это уже записано в `modelchecks.py:148-153` и
переспоривать это не надо. Предупреждение, вычет из счёта и число в `metrics.json` дают
90% пользы при нулевом риске.

**2. Не делать общую проверку толщины стенок «по всей детали».** Уже пробовали, уже
провалилось, вывод записан в `checklib.py:51-56`: стрельба лучами по нормалям B-rep
даёт ложный красный на обычной сплайновой геометрии — лофтах, свипах, импортированном
STEP — и никакая фильтрация артефактов не сделала число надёжным. Проверка минимального
элемента из пункта 2 работает только на НАЗВАННЫХ автором сечениях и имеет
одностороннюю ошибку. Соблазн «а давай просто пройдём по всем граням» вернётся —
не поддавайся, и не удаляй тот комментарий: он единственное, что стоит между следующим
агентом и повторением.

**3. Не угадывать провенанс по имени константы.** Правило пункта 4 обязательное, но
смотрит оно на регистр имени и на тип значения — вещи, которые видно в исходнике
буквально. Эвристика «`*_CLEARANCE`, `*_FIT`, `*_GAP` — это зазоры, а остальное можно
не объявлять» соблазнительна и неверна в обе стороны: она пропустит `LIP` и `SLOP`
и потребует источника у `NOZZLE_CLEARANCE_UNUSED`. Правило, которое нельзя объяснить
одной строчкой, автор не выполняет, а обходит.

**4. Не добавлять замер расстояния в `pairwise_interference`.** Соблазн понятен —
зазоры нужны пункту 6, а эту функцию зовут все. Но `BRepExtrema_DistShapeShape` на паре
реальных солидов — это десятки миллисекунд, а функция проверяет ВСЕ пары. Сборка из
пятнадцати деталей — это 105 пар, то есть несколько секунд, добавленных к каждой сборке
без спроса, ради числа, которое спрашивали не в ней. Зазоры приходят из
`swept_clearance`, которую зовёт тот, кому она нужна, и на том числе положений, которое
он назвал.

**5. Не менять формат `metrics.json` версией.** Разобрано в пункте 6. `METRICS_VERSION`
существует для случая, когда читатель старого файла прочтёт его НЕПРАВИЛЬНО; добавление
полей — не этот случай, а бумп сломает сравнение с каждой уже опубликованной ревизией
(сборка «отказывается сравнивать с версией, которую не знает»).

**6. Не пытаться рендерить вид `print` из тесселированного `print.json`.** Он в формате
`ocp_tessellate`, у него другая геометрия буферов, и это привяжет рендерер превью к
формату вьювера — двум вещам, которые сегодня не знают друг о друге. Компаунд плюс
`exportStl` — двадцать строк, использующих механику, которая уже работает для
`assembled`.

**7. Не добавлять подетальные `<name>_preview.png` в `downloads`.** Объявить их в
`files` — да, это ставит их под проверку имени и открытие на публикации. Но каждая метка
в `downloads` — это кнопка на странице сборки, и при десяти деталях получается тридцать
кнопок вместо двадцати, тогда как сама деталь в браузере видна в 3D. Обзорных картинок
две на всю сборку, и именно поэтому в `downloads` попадают только они. Подетальные
остаются на своих URL — они там и сегодня.

**8. Не заводить второй маршрут и второй канал для картинок.** Каталог сборки уже
раздаётся целиком (`app.py:744-755`), `downloads` в `meta.json` уже говорит клиенту
имена, `hammerola artifacts` уже ходит по ним. Новый эндпоинт «отдай превью» — это новый
маршрут, новый тест на права и новая строка в `ci/smoke.py` ради файла, который и так
лежит по своему URL. Единственное, чего в раздаче не хватает, — строчки `.png` в
`BUILD_CONTENT_TYPES` (`app.py:258-264`), и это правка одной строки, а не канал.
(Осторожно: `.png` в `app.py:274` — это таблица вложений к комментариям, другая таблица;
не перепутай их и не расширяй вторую.)

**9. Не ходить за baseline по HTTP из сборочного процесса.** Докстринг говорит
«`fetch_baseline`, which GET's the previous metrics.json off `{hub}/project/<pid>/dev/`»,
и соблазн реализовать написанное — прямой. Не надо, по трём причинам, каждой из которых
хватило бы. Внутри хаба это запрос за собственным файлом на собственном томе. Среда
ребёнка собрана по ключу и не несёт ни одного креденшла (`runner.child_environment`), а
процесс, в котором работает чужая модель, — последнее место, куда стоит добавлять сеть.
И главное: сборка, которой для публикации нужен успешный сетевой запрос, падает от
недоступной сети, а весь смысл `report_metrics` в том, что напечатанный diff не может
уронить сборку. Baseline — это файл, который родитель кладёт ребёнку в scratch.

**10. Не делать напечатанный diff основанием для чего-либо в хабе.** Модель живёт в том
же процессе, знает `sys.argv` и может переписать и baseline, и вывод (`child.py:30-44`).
Публикация идёт по списку файлов, проверенному родителем, и по коду возврата — так уже
устроено, и сводка ничего в этом не меняет. Соблазн появится в форме «а давай не
публиковать, если физика не сдвинулась»: это решение по данным из недоверенного
процесса, и оно принимается человеком, глядя в лог, а не хабом.

**11. Не трогать `docs/SPEC.md` в рамках этого наряда.** Над ним работает другая сессия.
Решения, которые эта работа принимает, фиксируются здесь и в докстрингах затронутых
модулей — по здешней традиции докстринг и есть место, где живёт обоснование. Когда
наряд закрыт, отдельным коммитом можно перенести в SPEC §8 то, что переживёт эту
задачу: резервирование стема `print`, словарь провенанса, решение НЕ отказывать на
тавтологии и то, что baseline для сводки — это слот `dev` того же проекта.
