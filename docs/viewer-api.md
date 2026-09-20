# three-cad-viewer: что доступно, когда её интерфейс погашен

Проверено чтением кода, а не по документации: онлайн-документация к версии 5.0.1
местами ей не соответствует. Источник истины — исходники форка библиотеки в
`viewer/`; ссылки ниже имеют вид `viewer/src/<файл>:<строка>` и ведут туда, а не в
собранный бандл `static/_v/three-cad-viewer.esm.js`: бандл перестраивается
`make viewer` и нумерацию строк не сохраняет.

**Зачем документ.** Мы строим свой интерфейс поверх библиотеки, запуская её с
`tools: false`. Всё ниже — ответ на вопрос «до чего мы дотягиваемся, когда её панель
погашена». Знание стоило двух отдельных разборов бандла; перепроверять не надо.

---

## 1. `tools: false` — это чисто CSS

Ключевой факт, на котором стоит весь план: **при `tools: false` вся машинерия
библиотеки создаётся и живёт, скрыт только UI.**

```js
// viewer/src/core/viewer.ts:1720, в конце render()
if (!this.state.get("tools")) {
    this.display.showToolsPanel(false);
    this.rendered.orientationMarker.setVisible(false);
}
```

`showToolsPanel` (`viewer/src/ui/display.ts:3458`) правит `style.display` у дерева,
значка сворачивания, маркера ориентации и слайдера анимации. `showTools`
(`viewer/src/ui/display.ts:1874`) — у тулбара и навигации. Больше ничего.

DOM шаблона создаётся целиком и безусловно (`container.innerHTML = TEMPLATE(...)`,
`viewer/src/ui/display.ts:397`), кнопки — тоже (`viewer/src/ui/display.ts:593–749`;
флаги `measureTools`/`selectTool`/`explodeTool`
управляют только `button.show()`). `Display.getElement` при промахе возвращает
`document.createElement("div")` — то есть **не бросает**. Ничего не найдено, что падало
бы из-за отсутствующего элемента панели.

Форк ради собственного интерфейса не нужен. Единственное, ради чего он может
понадобиться, — отсутствие `external: three` в её rollup-конфиге, из-за чего к её
экземпляру three.js не подцепить аддоны (`TransformControls` под ручки секущей
плоскости). Ровно это и произошло: библиотека форкнута в `viewer/`, её rollup-конфиг
собирается с `external: three`, а сам three.js приезжает отдельными файлами
`static/_v/three.module.js` и `static/_v/three.core.js`.

### Что при этом остаётся видимым и мешает

`div.tcv_status_line` и обе измерительные панели лежат в `tcv_cad_view`, а не в тулбаре,
поэтому `showTools(false)` их не трогает. Ховер-преселект включён всегда
(`hoverPreselectActive()`, `viewer/src/core/picking-controller.ts:160` — гасится только
для формата GDS и в Studio-режиме) и на каждом движении мыши пишет в
`display.setStatusLine(text)` (`viewer/src/core/picking-controller.ts:248` →
`viewer/src/ui/display.ts:951`) бейдж
вида `Circle: r ≈ 5.00, c ≈ (...), len ≈ 31.42` поверх канваса.

**Его надо погасить.** Но он же и подарок: `setStatusLine` — обычный метод, его можно
подменить и получать ховер-измерения себе. Готовый источник «диаметра под курсором».

---

## 2. Измерения — считаются внутри, писать своё не надо

Это самая ценная находка. У нас измерения годами стояли выключенными с
комментарием «needs a backend we do not run (SPEC 2.4)» — **это устарело**. В версии 5.0.1 есть
mesh-бэкенд, считающий из тесселяции, без питоновского `ocp_vscode`.

Создаётся безусловно, в конструкторе `Viewer`, от `tools` не зависит:

```js
this.cadTools    = new Tools(this);                                    // viewer/src/core/viewer.ts:466
this.meshBackend = new MeshMeasureBackend(() => this.compactNestedGroup?.meshGeometry ?? null); // viewer/src/core/viewer.ts:467
```

### Публичный API

**`viewer.meshBackend.distance(path1, path2, center)`** —
`viewer/src/tools/cad_tools/mesh-measure.ts:1536`

`center: false` даёт **минимальное** расстояние (точный branch-and-bound по BVH,
`viewer/src/tools/cad_tools/mesh-measure.ts:1163`), `true` — между центроидами.
Возвращает `null`, если путь не разрезолвился.

```js
{
  tool_type: "DistanceMeasurement", meshBased: true,
  refpoint1: [x,y,z], refpoint2: [x,y,z],
  result: [
    { distance: Number, "⇒ X | Y | Z": [dx,dy,dz], info: "center"|"min" },
    { "point 1": [x,y,z], "point 2": [x,y,z] },
    { angle: Number /* градусы */, "reference 1": "face normal"|"line", ... }  // если у обоих есть направление
  ]
}
```

**`viewer.meshBackend.properties(path)`** —
`viewer/src/tools/cad_tools/mesh-measure.ts:1479`

```js
{
  tool_type: "PropertiesMeasurement", meshBased: true,
  shape_type: "Face"|"Edge"|"Vertex"|"Solid",        // точный, из OCCT
  geom_type: "Plane"|"Cylinder"|"Circle"|"Line"|..., // точный GeomAbs
  refpoint: [x,y,z],
  result: [...]   // состав зависит от топологии
}
```

Состав `result` (`viewer/src/tools/cad_tools/mesh-measure.ts:1485–1521`):

| Топология | Что приходит |
| --- | --- |
| vertex | `xyz` |
| edge | `center`, `length`, `angle to XY`, `bb`; для `geom_type === "Circle"` ещё `radius` и `diameter` |
| face | `center`, `area`, `angle to XY`, `bb` |
| solid | `volume`, `bb` |

`bb` (`viewer/src/tools/cad_tools/mesh-measure.ts:355`) = `{min, center, max, size}`.

### Формат пути

Регэксп `viewer/src/tools/cad_tools/mesh-measure.ts:1233`:

```
/^(.*)\/(faces|edges|vertices)\/(?:faces|edges|vertices)_(\d+)$/
```

Примеры: `/Group/part/faces/faces_12`, `/Group/part/edges/edges_3`. Не совпало — путь
считается солидом целиком (объём, габарит, центроид по всему мешу). Пути узлов — те же
ключи, что у `viewer.getStates()`.

### Как получать числа

**Правильный способ — звать `meshBackend` напрямую.** Никакого состояния, никаких
инструментов и панелей, синхронный возврат.

В `notifyCallback` числа измерения **не приходят никогда**. Наружу уходит только
`selectedShapeIDs` — какие пути выбраны (`viewer/src/tools/cad_tools/measure.ts:404`);
это хук для внешнего питоновского бэкенда. При `externalMeasurementBackend: false`
ответ считается локально и оседает внутри (`Tools.handleResponse`
`viewer/src/tools/cad_tools/tools.ts:239` → `measurement.responseData` → панель).

Отсюда полезная связка: слушать `selectedShapeIDs` и на нём самим звать `meshBackend` —
получается «человек ткнул мышью, мы посчитали».

`viewer.cadTools.answerMeasurement(payload)`
(`viewer/src/tools/cad_tools/tools.ts:215`) работает **только** при уже
включённом инструменте, иначе тихий no-op, и результат уходит в панель, а не наружу.

### Единиц нет, и это имеет последствия

Числа — в тех координатах, в которых пришла тесселяция; конвертации в коде не
существует. Координаты **мировые**, с учётом трансформаций сборки
(`viewer/src/tools/cad_tools/mesh-measure.ts:1326–1346`).

Отсюда два следствия, оба признаны в самом коде:

- **Explode и анимация разносят детали, поэтому расстояния МЕЖДУ деталями поедут.**
  Комментарий `viewer/src/core/picking-controller.ts:225–229`: кэшируются только
  «coord-free» величины (площадь грани, объём солида), всё с координатами
  пересчитывается каждый раз.
- **Z-scale искажает измерения.** `setZscaleValue` (`viewer/src/core/viewer.ts:3173`)
  масштабирует группу, рядом
  `invalidateHoverCache()` с комментарием «world-space lengths/areas/coords change with
  z-scale».

Внутри одной детали (толщина стенки, диаметр отверстия, длина ребра) всё честно всегда.

Точность (`viewer/src/tools/cad_tools/mesh-measure.ts:28–29`): `shape_type` и
`geom_type` **точные**, числа mesh-accurate — точные для плоских граней и прямых рёбер,
в пределах deflection тесселяции для кривых. Радиус окружности — подгонка по полилинии
(`viewer/src/tools/cad_tools/mesh-measure.ts:269`), поэтому библиотека печатает его
с `≈`.

---

## 3. Полупрозрачность отдельной детали — публичного API нет, путь есть

`viewer.setTransparent(flag)` (`viewer/src/core/viewer.ts:2466`) и `setOpacity(v)`
(`viewer/src/core/viewer.ts:2542`) — **глобальные**: внутри `_traverse` по всем группам
(`viewer/src/scene/nestedgroup.ts:1386` и `:1418`). Точечно не применяются.
`viewerOptions.transparent` — тоже глобальный, применяется один раз при `render()`
(`viewer/src/core/viewer.ts:1319`).

Точечный путь — через группу детали:

```js
const group = viewer.nestedGroup.groups[path];   // path — ключ из getStates()
group.opacity = 0.25;
group.setTransparent(true);                       // viewer/src/scene/objectgroup.ts:480
viewer.update(true, false);
```

`ObjectGroup.setTransparent` (`viewer/src/scene/objectgroup.ts:480`) ставит
`opacity = flag ? this.opacity * this.alpha
: this.alpha` фронтальному и обратному мешам и правит `depthWrite`. Безопасно, потому
что `MaterialFactory._createBaseProps` (`viewer/src/rendering/material-factory.ts:181`)
ставит `transparent: true` **всем**
face-материалам всегда — пересборка шейдера не нужна. В CAD-режиме материал у каждой
детали свой.

**Ограничения:**

- **Studio-режим ломает точечность**: материалы там шарятся через `_studioMaterialCache`
  (`viewer/src/scene/nestedgroup.ts:1546–1549`) по `sharingKey`, и правка
  `front.material.opacity` протечёт на все детали с
  тем же материалом. В CAD-режиме проблемы нет.
- Глобальный `viewer.setTransparent`/`setOpacity` **перетрёт** точечную настройку.
  Смешивать нельзя: либо наш слой, либо её тумблер.
- Рёбра `setTransparent` не трогает (только `depthWrite`); приглушать их — руками через
  `group.edgeMaterial.opacity`. Флаг `transparent` у `LineMaterial` не проверен.
- Узел целиком — `CompoundGroup` метода `setTransparent` не имеет, надо перебирать
  листья: `Object.keys(viewer.getStates()).filter(p => p === node || p.startsWith(node + "/"))`.

---

## 4. `getStates` / `setStates` — это ТОЛЬКО видимость

```js
{ "/путь/листа": [shapeState, edgesState] }
const States = { unselected: 0, selected: 1, mixed: 2, disabled: 3 };   // viewer/src/rendering/tree-model.ts:4
```

`[0]` — тело, `[1]` — рёбра. `2` (mixed) вычисляется автоматически для узлов
(`_updateParentStates`, `viewer/src/rendering/tree-model.ts:383`); для листа задавать
бессмысленно — `setState` (`viewer/src/rendering/tree-model.ts:314`) сравнивает строго
с `selected`, так что `2` = «скрыть». `3` (disabled) — иконки нет вовсе, записать
нельзя.

Цепочка: `setState` → `toggleNodeState` → `Viewer.setObject`
(`viewer/src/core/viewer.ts:2032`) →
`ObjectGroup.setShapeVisible` / `setEdgesVisible`. **Прозрачности здесь нет.**

Работает при `tools: false`: DOM дерева скрыт, но модель — источник истины, `setObject`
зовётся всё равно. `TreeView.update()` фильтрует по `getBoundingClientRect().height > 0`,
то есть иконки в скрытом дереве не перерисуются, на 3D это не влияет.

---

## 5. Выделение детали

Шейдерная подсветка через R8UI-текстуру состояний, per-object материалы не трогаются.
`HighlightController` (`viewer/src/rendering/highlight.ts:204`) живёт как
`viewer.nestedGroup.highlight`.

```js
const hl = viewer.nestedGroup.highlight;   // null до render()
hl.selectSolid(path, true);                // viewer/src/rendering/highlight.ts:376
viewer.update(true, false);
hl.clear();                                // viewer/src/rendering/highlight.ts:385
```

- красит **только грани** (`topo === "face"`, `viewer/src/rendering/highlight.ts:378`) —
  осознанно, рёбра остаются своего цвета;
- `solidPath` — тот же ключ, что в `getStates()`; у не-солида он `null`, там нужен
  `setSelected(id, true)` по конкретным id из
  `[...viewer.nestedGroup.registry.entries()]` (`viewer/src/rendering/id-picking.ts:204`);
- цвета захардкожены (`0x53a0e3` выделение, `0x89b9e3` ховер,
  `viewer/src/rendering/highlight.ts:21` и `:24`), меняются
  через `hl.uniforms.uHighlightSelectedColor.value.set(...)` — необходимость
  `needsUpdate` не проверена;
- требует рендера: `viewer.update(true, false)`.

**Конфликт с мышью:** `PickingController` пишет в тот же битовый набор. Если не нужно —
`viewer.setSelectionInput(false)` (при `tools: false` и без активного инструмента он и
так выключен).

Рамка вокруг детали — `viewer.setBoundingBox(id)` (`viewer/src/core/viewer.ts:2074`),
**тумблер**; снять явно `viewer.removeLastBbox()` (`viewer/src/core/viewer.ts:2176`).
Учесть: `handlePick` строит `id` как
`` `${path}/${name}` ``, то есть родитель + имя, в отличие от остальных API, где путь
целиком.

---

## 6. Клиппинг: считается всегда, но по умолчанию не режет

`setClipNormal`, `setClipSlider`, `resetClip`, `getClipNormal`/`getClipSlider` работают.
**Но визуально ничего не обрежется**, пока `renderer.localClippingEnabled === false`, а
в конце `render()` стоит `this.setLocalClipping(false)`
(`viewer/src/core/viewer.ts:1697`) с комментарием «only allow clipping when Clipping tab
is selected»; `true` ставится только из `switchToTab("clip")`
(`viewer/src/ui/display.ts:2119`) — куда при `tools: false` не попасть.

Лечится `viewer.setLocalClipping(true)` (`viewer/src/core/viewer.ts:2014`). Для торцевых
крышек дополнительно нужен `clipping.setVisible(true)`: в `render()` стоит
`setVisible(false)` (`viewer/src/core/viewer.ts:1699`), а
`Clipping.cull(..., clipActive)` (`viewer/src/scene/clipping.ts:694`) при `false` гасит
все стенсилы и cap-меши.

**У нас это уже решено** — `keepSectionCut()` в `ui/src/viewport/section.js`,
перенесённый из страничного вьювера, который был до React-интерфейса. Логику не
выбрасывать.

Не прослежено: достаточно ли одного `setLocalClipping(true)` без `setActiveTab("clip")`
для корректных крышек — по коду похоже, что нет.

---

## 7. Единственный систематический источник исключений

Геттер `this.rendered` (`viewer/src/core/viewer.ts:307`) бросает
`Error("Viewer.render() must be called before
this operation")`, если `render()` ещё не вызван. Это **не связано с `tools`** — только
с порядком вызовов, и затрагивает почти все сеттеры.

Осторожно: `?.` от бросающего геттера не спасает. В самом коде это отмечено в
`onIdHoverLeave` (`viewer/src/core/picking-controller.ts:143–150`) — там сначала
проверяют `host.ready`.

Тихие no-op (не падают): `setStates` при `_rendered === null`, `setAxes`/`setAmbientLight`
при `!ready`, `getImage` при `!ready` (вернёт `dataUrl: null`), `update()` при `!ready`,
`answerMeasurement` при выключенном инструменте, `meshBackend.*` при неизвестном пути.

---

## 8. Чего утверждать нельзя

Перечислено честно, чтобы никто не принял это за проверенное:

1. Подача «искусственного выбора» в `cadTools.handleSelectedObj` — формально возможна,
   но `IdPicked` не экспортирован, а `PickingController` параллельно перетирает
   `lastObject` на каждом ховере. Не прослежено.
2. Достаточность `setLocalClipping(true)` без `setActiveTab("clip")` для крышек.
3. Флаг `transparent` у `LineMaterial` (прозрачность рёбер).
4. Нужен ли `needsUpdate` после смены цвета подсветки через uniform.
5. Наличие `tcv_measure_subheader` в шаблоне: `PropertiesPanel.setSubHeader`
   (`viewer/src/tools/cad_tools/ui.ts:344`) обращается к элементу без guard-а и
   теоретически может бросить.
6. Где вешаются слушатели `KeyMapper`/`setKeyMap` и гасятся ли они при `tools: false`.
7. Поведение mesh-бэкенда на формате GDS: `meshGeometry` регистрируется, но наличие
   `face_types`/`edge_types` не проверено; ховер-преселект для GDS библиотека отключает
   явно (`viewer/src/core/picking-controller.ts:161`).
