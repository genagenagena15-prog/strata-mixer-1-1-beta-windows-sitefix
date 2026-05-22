# Strata Mixer v1.3 beta — автообновление

В этой версии добавлено автообновление без ручного скачивания:

1. При запуске программа читает https://stratamixer.net/version.json
2. Если версия на сайте выше установленной:
   - программа не открывает главный экран;
   - сама скачивает Windows installer из windowsUrl;
   - показывает прогресс загрузки;
   - запускает установщик;
   - закрывает Strata Mixer.

Важно:
- v1.2 beta ещё не умеет автообновляться. Пользователи v1.2 один раз обновятся вручную до v1.3.
- Начиная с v1.3, следующие версии смогут скачиваться через окно автообновления.

Как выпускать следующую версию, например v1.4 beta:

1. Собрать новый установщик:
   StrataMixer_Setup_1_4_beta.exe

2. Загрузить его в GitHub Release, например:
   tag: v1.4.0-beta

3. В version.json сайта указать:
   latest: 1.4.0-beta
   displayVersion: v1.4 beta
   required: true
   windowsUrl: https://github.com/genagenagena15-prog/strata-mixer-releases/releases/download/v1.4.0-beta/StrataMixer_Setup_1_4_beta.exe

4. Загрузить обновлённый сайт на Cloudflare Pages.

После этого пользователи v1.3 увидят окно автообновления, программа сама скачает installer и запустит его.
