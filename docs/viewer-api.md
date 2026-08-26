# three-cad-viewer: что доступно, когда её интерфейс погашен

Проверено по вендоренному бандлу `static/_v/three-cad-viewer.esm.js` (версия 5.0.1,
115812 строк) чтением кода, а не по документации: онлайн-документация к этой версии
местами не соответствует. Номера строк — по этому файлу.

**Зачем документ.** Мы строим свой интерфейс поверх библиотеки, запуская её с
`tools: false`. Всё ниже — ответ на вопрос «до чего мы дотягиваемся, когда её панель
погашена». Знание стоило двух отдельных разборов бандла; перепроверять не надо.

---

## 1. `tools: false` — это чисто CSS

Ключевой факт, на котором стоит весь план: **при `tools: false` вся машинерия
библиотеки создаётся и живёт, скрыт только UI.**

```js
// :111081, в конце render()
if (!this.state.get("tools")) {
    this.display.showToolsPanel(false);
    this.rendered.orientationMarker.setVisible(false);
}
```

`showToolsPanel` (:113918) правит `style.display` у дерева, значка сворачивания,
маркера ориентации и слайдера анимации. `showTools` (:113368) — у тулбара и навигации.
Больше ничего.

DOM шаблона создаётся целиком и безусловно (`container.innerHTML = TEMPLATE(...)`,
:113943), кнопки — тоже (:114095–114127; флаги `measureTools`/`selectTool`/`explodeTool`
управляют только `button.show()`). `Display.getElement` при промахе возвращает
`document.createElement("div")` — то есть **не бросает**. Ничего не найдено, что падало
бы из-за отсутствующего элемента панели.

Форк ради собственного интерфейса не нужен. Единственное, ради чего он может
понадобиться, — отсутствие `external: three` в её rollup-конфиге, из-за чего к её
экземпляру three.js не подцепить аддоны (`TransformControls` под ручки секущей
плоскости).

### Что при этом остаётся видимым и мешает

`div.tcv_status_line` и обе измерительные панели лежат в `tcv_cad_view`, а не в тулбаре,
поэтому `showTools(false)` их не трогает. Ховер-преселект включён всегда
(`hoverPreselectActive()`, :97545 — гасится только для формата GDS и в Studio-режиме) и
на каждом движении мыши пишет в `display.setStatusLine(text)` (:97626 → :114328) бейдж
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
this.cadTools    = new Tools(this);                                    // :110367
this.meshBackend = new MeshMeasureBackend(() => this.compactNestedGroup?.meshGeometry ?? null); // :110368
```

### Публичный API

**`viewer.meshBackend.distance(path1, path2, center)`** — :86623

`center: false` даёт **минимальное** расстояние (точный branch-and-bound по BVH,
:86300), `true` — между центроидами. Возвращает `null`, если путь не разрезолвился.

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

**`viewer.meshBackend.properties(path)`** — :86563

```js
{
  tool_type: "PropertiesMeasurement", meshBased: true,
  shape_type: "Face"|"Edge"|"Vertex"|"Solid",        // точный, из OCCT
  geom_type: "Plane"|"Cylinder"|"Circle"|"Line"|..., // точный GeomAbs
  refpoint: [x,y,z],
  result: [...]   // состав зависит от топологии
}
```

Состав `result` (:86569–86612):

| Топология | Что приходит |
| --- | --- |
| vertex | `xyz` |
| edge | `center`, `length`, `angle to XY`, `bb`; для `geom_type === "Circle"` ещё `radius` и `diameter` |
| face | `center`, `area`, `angle to XY`, `bb` |
| solid | `volume`, `bb` |

`bb` (:85592) = `{min, center, max, size}`.

### Формат пути

Регэксп :86338:

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
`selectedShapeIDs` — какие пути выбраны (:96868); это хук для внешнего питоновского
бэкенда. При `externalMeasurementBackend: false` ответ считается локально и оседает
внутри (`Tools.handleResponse` :97274 → `measurement.responseData` → панель).

Отсюда полезная связка: слушать `selectedShapeIDs` и на нём самим звать `meshBackend` —
получается «человек ткнул мышью, мы посчитали».

`viewer.cadTools.answerMeasurement(payload)` (:97257) работает **только** при уже
включённом инструменте, иначе тихий no-op, и результат уходит в панель, а не наружу.

### Единиц нет, и это имеет последствия

Числа — в тех координатах, в которых пришла тесселяция; конвертации в коде не
существует. Координаты **мировые**, с учётом трансформаций сборки (:86414–86419).

Отсюда два следствия, оба признаны в самом коде:

- **Explode и анимация разносят детали, поэтому расстояния МЕЖДУ деталями поедут.**
  Комментарий :97595–97599: кэшируются только «coord-free» величины (площадь грани,
  объём солида), всё с координатами пересчитывается каждый раз.
- **Z-scale искажает измерения.** `setZscaleValue` (:111484) масштабирует группу, рядом
  `invalidateHoverCache()` с комментарием «world-space lengths/areas/coords change with
  z-scale».

Внутри одной детали (толщина стенки, диаметр отверстия, длина ребра) всё честно всегда.

Точность (:85336–85338): `shape_type` и `geom_type` **точные**, числа mesh-accurate —
точные для плоских граней и прямых рёбер, в пределах deflection тесселяции для кривых.
Радиус окружности — подгонка по полилинии (:85513), поэтому библиотека печатает его
с `≈`.

---

## 3. Полупрозрачность отдельной детали — публичного API нет, путь есть

`viewer.setTransparent(flag)` (:109481) и `setOpacity(v)` (:109528) — **глобальные**:
внутри `_traverse` по всем группам (:88124, :88153). Точечно не применяются.
`viewerOptions.transparent` — тоже глобальный, применяется один раз при `render()`
(:110811).

Точечный путь — через группу детали:

```js
const group = viewer.nestedGroup.groups[path];   // path — ключ из getStates()
group.opacity = 0.25;
group.setTransparent(true);                       // :82497
viewer.update(true, false);
```

`ObjectGroup.setTransparent` (:82497) ставит `opacity = flag ? this.opacity * this.alpha
: this.alpha` фронтальному и обратному мешам и правит `depthWrite`. Безопасно, потому
что `MaterialFactory._createBaseProps` (:83420) ставит `transparent: true` **всем**
face-материалам всегда — пересборка шейдера не нужна. В CAD-режиме материал у каждой
детали свой.

**Ограничения:**

- **Studio-режим ломает точечность**: материалы там шарятся через `_studioMaterialCache`
  (:87404) по `sharingKey`, и правка `front.material.opacity` протечёт на все детали с
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
const States = { unselected: 0, selected: 1, mixed: 2, disabled: 3 };   // :89596
```

`[0]` — тело, `[1]` — рёбра. `2` (mixed) вычисляется автоматически для узлов
(`_updateParentStates`, :89884); для листа задавать бессмысленно — `setState` (:89828)
сравнивает строго с `selected`, так что `2` = «скрыть». `3` (disabled) — иконки нет
вовсе, записать нельзя.

Цепочка: `setState` → `toggleNodeState` → `Viewer.setObject` (:109181) →
`ObjectGroup.setShapeVisible` / `setEdgesVisible`. **Прозрачности здесь нет.**

Работает при `tools: false`: DOM дерева скрыт, но модель — источник истины, `setObject`
зовётся всё равно. `TreeView.update()` фильтрует по `getBoundingClientRect().height > 0`,
то есть иконки в скрытом дереве не перерисуются, на 3D это не влияет.

---

## 5. Выделение детали

Шейдерная подсветка через R8UI-текстуру состояний, per-object материалы не трогаются.
`HighlightController` (:85061) живёт как `viewer.nestedGroup.highlight`.

```js
const hl = viewer.nestedGroup.highlight;   // null до render()
hl.selectSolid(path, true);                // :85195
viewer.update(true, false);
hl.clear();                                // :85197
```

- красит **только грани** (`topo === "face"`, :85190) — осознанно, рёбра остаются
  своего цвета;
- `solidPath` — тот же ключ, что в `getStates()`; у не-солида он `null`, там нужен
  `setSelected(id, true)` по конкретным id из
  `[...viewer.nestedGroup.registry.entries()]` (:84090);
- цвета захардкожены (`0x53a0e3` выделение, `0x89b9e3` ховер, :84938/84940), меняются
  через `hl.uniforms.uHighlightSelectedColor.value.set(...)` — необходимость
  `needsUpdate` не проверена;
- требует рендера: `viewer.update(true, false)`.

**Конфликт с мышью:** `PickingController` пишет в тот же битовый набор. Если не нужно —
`viewer.setSelectionInput(false)` (при `tools: false` и без активного инструмента он и
так выключен).

Рамка вокруг детали — `viewer.setBoundingBox(id)` (:109215), **тумблер**; снять явно
`viewer.removeLastBbox()` (:111256). Учесть: `handlePick` строит `id` как
`` `${path}/${name}` ``, то есть родитель + имя, в отличие от остальных API, где путь
целиком.

---

## 6. Клиппинг: считается всегда, но по умолчанию не режет

`setClipNormal`, `setClipSlider`, `resetClip`, `getClipNormal`/`getClipSlider` работают.
**Но визуально ничего не обрежется**, пока `renderer.localClippingEnabled === false`, а
в конце `render()` стоит `this.setLocalClipping(false)` (:111066) с комментарием «only
allow clipping when Clipping tab is selected»; `true` ставится только из
`switchToTab("clip")` (:114969) — куда при `tools: false` не попасть.

Лечится `viewer.setLocalClipping(true)` (:111235). Для торцевых крышек дополнительно
нужен `clipping.setVisible(true)`: в `render()` стоит `setVisible(false)` (:111067), а
`Clipping.cull(..., clipActive)` (:91364) при `false` гасит все стенсилы и cap-меши.

**У нас это уже решено** — `keepSectionCut()` в `ui/src/viewport/section.js`,
перенесённый из страничного вьювера, который был до React-интерфейса. Логику не
выбрасывать.

Не прослежено: достаточно ли одного `setLocalClipping(true)` без `setActiveTab("clip")`
для корректных крышек — по коду похоже, что нет.

---

## 7. Единственный систематический источник исключений

Геттер `this.rendered` (:108819) бросает `Error("Viewer.render() must be called before
this operation")`, если `render()` ещё не вызван. Это **не связано с `tools`** — только
с порядком вызовов, и затрагивает почти все сеттеры.

Осторожно: `?.` от бросающего геттера не спасает. В самом коде это отмечено в
`onIdHoverLeave` (:97440–97444) — там сначала проверяют `host.ready`.

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
5. Наличие `tcv_measure_subheader` в шаблоне: `PropertiesPanel.setSubHeader` (:96372)
   обращается к элементу без guard-а и теоретически может бросить.
6. Где вешаются слушатели `KeyMapper`/`setKeyMap` и гасятся ли они при `tools: false`.
7. Поведение mesh-бэкенда на формате GDS: `meshGeometry` регистрируется, но наличие
   `face_types`/`edge_types` не проверено; ховер-преселект для GDS библиотека отключает
   явно (:97546).
