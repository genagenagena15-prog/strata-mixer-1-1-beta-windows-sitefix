# Обязательные обновления Strata Mixer

Эта версия программы при запуске проверяет:

https://stratamixer.net/version.json

Если в `version.json` указана версия выше установленной и `required: true`, программа не открывает главное окно.
Пользователь видит окно обновления и может только скачать новую версию или закрыть программу.

## Текущая версия программы

Сейчас в `package.json`:

```json
"version": "1.1.0-beta"
```

Пока на сайте в `/version.json` тоже:

```json
"latest": "1.1.0-beta"
```

программа запускается нормально.

## Как выпустить обязательное обновление

1. В `package.json` новой программы поменять версию, например:

```json
"version": "1.1.1-beta"
```

2. Собрать новый installer:

```cmd
START_HERE_BUILD_WINDOWS_INSTALLER.bat
```

3. Полученный файл положить на сайт:

```text
/downloads/StrataMixer_Setup_1_1_1_beta.exe
```

4. В `version.json` на сайте указать новую версию:

```json
{
  "latest": "1.1.1-beta",
  "displayVersion": "v1.1.1 beta",
  "required": true,
  "windowsUrl": "https://stratamixer.net/downloads/StrataMixer_Setup_1_1_1_beta.exe",
  "macUrl": "https://stratamixer.net/downloads/StrataMixer_1_1_1_beta.dmg",
  "notes": "Короткое описание изменений."
}
```

5. Загрузить обновлённый сайт на Cloudflare Pages.

После этого все пользователи со старой версией увидят обязательное обновление и не смогут продолжить работу без установки новой версии.

## Если нужно проверить программу локально без проверки обновлений

Только в режиме разработки можно запустить с переменной:

```cmd
set STRATA_SKIP_UPDATE_CHECK=1
npm run dev
```

В собранной программе этот флаг не отключает проверку.
