---
description: Прогнать все проверки/тесты проекта (синтаксис + юнит + GPU-харнесс)
allowed-tools: Bash, Read, Glob
---

Прогони все проверки проекта **Strata Mixer** по порядку и кратко отчитайся: что прошло ✅ / что упало ❌.
Детали — в `CLAUDE.md`, раздел «Как гонять тесты». Делегируй это субагенту **tests**, если он есть.

Шаги:

1. **Синтаксис фронтенда:**
   ```
   npx esbuild src/main.jsx --loader:.jsx=jsx --bundle=false --outfile=NUL
   ```

2. **Синтаксис бэкенда:**
   ```
   node --check electron/main.js
   node --check electron/preload.js
   ```

3. **Юнит-тест миграции:**
   ```
   node proto/migrate-test.mjs
   ```

4. **Главный GPU-харнесс** — `proto/engine-fullcheck.html` (13 пиксельных тестов движка, норма 13/13):
   - если vite на :5180 не поднят — запусти `npm run vite-only` в фоне и дождись готовности;
   - удали старый `proto/last-bench.json`;
   - запусти в фоне (с таймаутом):
     `$env:BENCH_URL="http://localhost:5180/proto/engine-fullcheck.html"; electron proto/bench-electron.cjs`
   - дождись и прочитай `proto/last-bench.json` — ожидается **13/13**.

Если что-то упало — покажи конкретную ошибку (а для харнесса — какой из 13 тестов).
НЕ «чини» молча: сначала отчитайся результатом.
