# Выпуск Strata Mixer v1.0 final

Публичная версия:
   v1.0

Важно для автообновления:
   Внутренняя update-версия в package.json: 1.4.0

Почему так:
   У пользователей уже могла быть установлена v1.3.1 beta.
   Если в version.json поставить latest: 1.0.0, программа v1.3.1 не увидит обновление,
   потому что 1.0.0 меньше 1.3.1.
   Поэтому публично показываем v1.0, а технически для обновлений используем latest: 1.4.0.

Что изменено:
- Версия в интерфейсе: v1.0.
- Убран чёрный прямоугольник в пустом предпросмотре.
- Пока видео не загружено, показывается только прозрачная PNG-иконка на фоне программы.
- Автообновление Windows сохранено.

Как собрать:
   START_HERE_BUILD_WINDOWS_INSTALLER.bat

Готовый файл:
   installer-output\StrataMixer_Setup_1_0.exe

GitHub Release:
   tag: v1.0.0
   title: Strata Mixer v1.0
   asset: StrataMixer_Setup_1_0.exe

Что поставить в version.json сайта:
   latest: 1.4.0
   displayVersion: v1.0
   windowsUrl: https://github.com/genagenagena15-prog/strata-mixer-releases/releases/download/v1.0.0/StrataMixer_Setup_1_0.exe
