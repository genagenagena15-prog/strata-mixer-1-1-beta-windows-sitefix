---
description: Собрать проект (по умолчанию vite build renderer'а)
allowed-tools: Bash, Read
---

Собери проект **Strata Mixer**.

По умолчанию — сборка renderer'а (быстрая, проверяет, что фронт собирается):
```
npm run build      # vite build → dist/
```

Покажи итог: успех или конкретные ошибки сборки. Если ошибки — назови файл/строку, не «чини» молча.

Если пользователь просил **полную** сборку приложения — используй вместо этого:
- Windows-инсталлятор (NSIS): `npm run dist:win`   → `release-installer/`
- Портативная сборка (electron-packager): `npm run package:win`   → `release/`

> Полная сборка тянет ffmpeg и electron-builder — она долгая. Запускай её в фоне и дождись завершения.
> Перед релизной сборкой убедись, что `electron/groq-key.json` на месте (секрет, не коммитится).
