# CLAUDE.md — карта проекта Strata Mixer

Шпаргалка по проекту, чтобы не искать всё заново каждый раз.

**Strata Mixer** — десктоп-программа (Electron) для **уникализации и редактирования видео**:
мультитрек-таймлайн, GPU-эффекты, переходы, субтитры, экспорт через ffmpeg.

---

## Стек
- **Electron 42** (Chromium 148) — десктоп-оболочка.
- **React 19 + Vite 8** — интерфейс (renderer).
- **WebGL2 / GLSL ES 3.00** — свой GPU-компоновщик кадра (рисует и превью, и экспорт).
- **ffmpeg** (`bin/ffmpeg.exe` + пакет `ffmpeg-static`) — кодирование / декод / экспорт.
- **WebCodecs + mediabunny** — быстрый декод видео (0-copy текстуры) для движка.
- **Groq Whisper** — авто-субтитры и распознавание речи.
- Сборка: **electron-builder** (NSIS-инсталлятор) + electron-packager; авто-апдейт — **electron-updater**.

---

## Где что лежит (главное)

| Что | Где |
|---|---|
| **Фронтенд** (весь UI, компоненты, кнопки) | `src/main.jsx` (~460 КБ, один файл) |
| **Стили** (вся вёрстка / CSS) | `src/styles.css` (~220 КБ) |
| **HTML точка входа** | `index.html` → грузит `src/main.jsx` |
| **Бэкенд** (главный процесс, IPC, ffmpeg, экспорт) | `electron/main.js` (~216 КБ) |
| **Мост renderer ↔ main** (`window.strata`) | `electron/preload.js` |
| **GPU-движок** (компоновка кадра, шейдеры) | `src/engine/` |
| **GPU-эффекты** (переходы, стили текста, анимации) | `src/engine/effects/` |
| **Тесты / харнессы** | `proto/` |
| **Скрипты сборки / релиза** | `scripts/` |
| **Иконки, шрифты, сплеш** | `assets/` |
| **ffmpeg, whisper** | `bin/` |

> Большие файлы (`main.jsx`, `main.js`, `styles.css`) — **НЕ читай целиком**, ищи по Grep.

---

## Фронтенд (`src/main.jsx`)
Один большой файл, всё на React. Главные компоненты:
- `App` (≈442) — корень, табы: Главная / Уникализация / Формат / Распознавание речи / **Редактирование**.
- `Editor` (≈1976) — сам видеоредактор: превью, таймлайн, слои, эффекты, экспорт. **Самая важная часть.**
- `CompactHeader` (≈1297) — шапка с кнопками «Сохранить как проект» / «Сохранить как видео».
- `Home`, `Format`, `Unique`, `Watermark`, `Settings`, `TranscribeView`, `Preview` — другие табы/панели.
- `VolumeEnvelope` (≈301) — огибающая громкости на клипе.
- Мелочи: `Titlebar`, `NotificationBell`, `Slider`, `Switch`, `FontPicker`, модалки.

**Как работают кнопки шапки:** кнопки в `CompactHeader` шлют глобальные события
`window.dispatchEvent(new CustomEvent('strata:editor-save'))` и т.п.; `Editor` ловит их через
`addEventListener` (≈4379). События: `strata:editor-save` (экспорт видео),
`strata:editor-save-project`, `strata:editor-open-project`.

**Связь с бэкендом:** только через `window.strata.*` (определено в `electron/preload.js`).
Пример: `window.strata.editVideo(...)`, `window.strata.saveProject(...)`.

**Правка стилей:** `src/styles.css`. CSS применяется мгновенно (Vite HMR, без перезагрузки).
Правка `.jsx` → авто-reload страницы.

---

## Бэкенд (`electron/main.js` + `electron/preload.js`)
Главный процесс Electron: окна, файловые диалоги, ffmpeg, экспорт, сохранение/открытие проектов,
субтитры, апдейты.

**API наружу** = `ipcMain.handle('имя', ...)` в `main.js`, проброшенные в `preload.js` как
`window.strata.*`. Основные каналы:
- Файлы/диалоги: `files:pick`, `media:pick`, `image:pick`, `audio:pick`, `saveas:pick`, `folder:pick`.
- Проект: `project:save`, `project:open`, `project:open-path`.
- Экспорт видео: `video:edit` (путь через ffmpeg), `engine:export-begin / -frame / -finish` (рендер через GPU-движок → ffmpeg).
- Редактор: `editor:makeProxy`, `editor:concatClips`, `editor:previewProxyPath`, `editor:cancelPreview`, автосейв/восстановление.
- Хромакей: `chroma:sample-pixel` (пипетка через ffmpeg).
- Субтитры/речь: `subtitles:generate`, `transcribe:file` (Groq Whisper).
- Окно/система: `window:*`, `theme:save`, `fonts:list`, `system:detectRender`, `update:*`, `notifications:*`.

> **ffmpeg** — сердце экспорта. Команды (фильтры, `atrim/atempo/amix`, `chromakey`, `volume` и т.д.)
> собираются именно в `main.js`.

---

## Движок (`src/engine/`)
WebGL2-компоновщик: **один и тот же код рисует и превью, и экспорт** (1:1).
- `compositor.js` — класс `Compositor`, метод `renderFrame(frame)` рисует все слои сверху вниз
  (видео / картинки / текст / маски / хромакей / блюр / переходы). `renderTransitionPreview(...)` — превью перехода.
- `gl.js` — хелперы WebGL (программы, шейдеры `VS_QUAD` и т.п.).
- `caps.js` — определение возможностей GPU (`pickTier`: Tier A = есть WebGL2 + WebCodecs).
- `decode.js` — WebCodecs-декод (0-copy текстуры).
- `exportRender.js` — экспорт через движок (`renderFrame` → `readPixels` → ffmpeg).
- `textRaster.js` — текст → текстура.
- `effects/` — пак GPU-эффектов: `transitions.js` (переходы), `textStyles.js` (стили текста),
  `subAnims.js` (анимации субтитров), `index.js`.

---

## Зоны ответственности (для субагентов — `.claude/agents/`)
**Агенты, которые РЕДАКТИРУЮТ** (зоны не пересекаются):
- **frontend** → `src/main.jsx`, `src/styles.css`, `index.html` (UI, кнопки, вёрстка).
- **backend** → `electron/**` (главный процесс, IPC, ffmpeg, экспорт, проекты, субтитры, апдейты).
- **engine** → `src/engine/**` (GPU-компоновщик, шейдеры WebGL2/GLSL, пак эффектов).
- **release** → `scripts/`, `build/`, `.github/`, инсталлятор-файлы (`*.iss`/`*.nsh`/`*.bat`), секции `build`/`scripts` в `package.json`, `vite.config.js` (сборка, упаковка, релизы).
- **tests** → `proto/**` (харнессы, проверки).

**Агенты-советники** (только ЧИТАЮТ, ничего не правят — диагноз/ревью отдают владельцу зоны):
- **reviewer** — ревью diff перед коммитом (утечка секретов, регрессии, забытый перезапуск Electron).
- **perf** — производительность: render-loop, видео-декодеры, occlusion culling.
- **debugger** — воспроизводит и находит причину бага, не чиня.

Каждый редактирующий агент правит **только свою зону**; чужое — читает для контекста, не меняет.
`package.json` общий — правки в нём согласуй (зависимости — осторожно).

---

## Как запускать
```
npm install            # один раз
npm run dev            # vite (порт 5180) + Electron — основной режим разработки
```
- CSS-правки применяются мгновенно (HMR). `.jsx`-правки → авто-reload.
- ⚠️ После правок `electron/main.js` или `electron/preload.js` нужен **перезапуск** (`npm run dev` заново) —
  HMR их не подхватывает.
- Нельзя держать два `npm run dev` сразу (порт 5180 + single-instance Electron).

---

## Как собирать
```
npm run build          # vite build → dist/ (только renderer)
npm run dist:win       # build + ffmpeg + electron-builder → NSIS-инсталлятор (release-installer/)
npm run package:win    # портативная сборка electron-packager (release/)
```

---

## Как гонять тесты
Отдельного `npm test` нет. «Тесты» = быстрые проверки синтаксиса + GPU-харнессы в `proto/`.

**Быстрые проверки (без GUI):**
```
npx esbuild src/main.jsx --loader:.jsx=jsx --bundle=false --outfile=NUL   # синтаксис фронта
node --check electron/main.js                                            # синтаксис бэка
node --check electron/preload.js
node proto/migrate-test.mjs                                              # юнит-тест миграции
```

**GPU-харнессы** (нужен запущенный vite на :5180):
- `proto/engine-fullcheck.html` — **ГЛАВНЫЙ**: 13 пиксельных тестов движка
  (слои / хромакей / поворот / маски / блюр / переходы / текст). Норма — **13/13**.
- Прочие: `effects-compile.html`, `chroma-compile.html`, `rotate-check.html`, `textstyle-check.html`, `parity.html`.

**Как запустить харнесс** (через `proto/bench-electron.cjs`):
1. Поднять vite: `npm run vite-only` (или уже запущенный `npm run dev`).
2. Удалить старый результат `proto/last-bench.json`.
3. `$env:BENCH_URL="http://localhost:5180/proto/engine-fullcheck.html"`, затем `electron proto/bench-electron.cjs`.
4. Результат пишется в `proto/last-bench.json` (строка после `@@BENCH@@`).
- Готовый ярлык: `npm run bench` (поднимает vite + launcher; по умолчанию открывает `preview-bench.html`).

---

## Важные правила
- 🔒 **`electron/groq-key.json` — СЕКРЕТ** (в `.gitignore`). НИКОГДА не коммить. Репозиторий публичный.
- После правок `electron/main.js` / `preload.js` → **перезапуск Electron** (`npm run dev` заново).
- Коммитить только когда явно попросят. Ветка разработки: `feature/engine`.
- Превью и экспорт рисует ОДИН код (`compositor.renderFrame`) → проверил движок харнессом = проверил
  и превью, и экспорт.
- Ассистент НЕ видит GUI и не слышит звук — пользователь = визуальный/аудио-гейт.
- `nul.css` в корне — мусор от ошибочного редиректа `> nul`, можно игнорировать.
