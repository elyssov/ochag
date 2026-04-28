# Картография мусора C: — отчёт от агента

Дата: 2026-04-28
Агент: general-purpose, делегирован Ларой
Состояние диска C: на момент сканирования: 1.55 TB занято / 1.86 TB всего (свободно ~304 GB, 84%)
Состояние диска D: 2.9 TB занято / 3.7 TB всего (свободно ~785 GB)

## Сводка

- **Просмотрено:** ~1.4 TB подробно (без C:\Windows, C:\Program Files*, C:\ProgramData)
- **Кандидатов на перенос на D:** ~620 GB (игры + сейвы + моды + личные медиа)
- **Кандидатов на удаление:** ~36 GB (времянки, кэши, дубликаты установщиков)
- **Уверенно к переносу прямо сейчас:** ~480 GB (игры в C:\, не запускались > 6 мес, плюс F4/Stellaris сейвы)

Главный жирный пласт — **433 GB в C:\Games + 201 GB в C:\GOG Games + 100 GB в C:\VirtuaGirl + 73 GB в C:\Far Cry 5**. Это всё на корне C:, минуя стандартные локации Steam/GOG. Большинство — давно (полгода+) не запускалось.

## Топ-30 кандидатов

| #  | Путь                                                                                  | Размер  | Тип             | Возраст / последнее обращение         | Рекомендация                                              |
|----|---------------------------------------------------------------------------------------|---------|-----------------|---------------------------------------|-----------------------------------------------------------|
| 1  | `C:\GOG Games\Baldurs Gate 3`                                                         | 158 GB  | игра + сейвы    | mtime 2024-10-08 (1.5 года назад)     | Перенести на `D:\Games\BG3\` или удалить (GOG скачает заново) |
| 2  | `C:\Games\WarThunder`                                                                 | 137 GB  | игра            | mtime 2025-12-27 (играет, но изредка) | Перенести на `D:\Games\WarThunder\` (онлайн-патчер сам докачает; не удалять — большой даунлоад) |
| 3  | `C:\Games\Atomic Heart`                                                               | 120 GB  | игра            | mtime 2025-02-22                      | Перенести на `D:\Games\AtomicHeart\` или удалить (одноразовая, прошёл) |
| 4  | `C:\VirtuaGirl\Models`                                                                | 94 GB   | контент         | (Models/)                             | Перенести на `D:\Misc\VirtuaGirl\Models\` — точно не системное, в C:\ занимает зря |
| 5  | `C:\Far Cry 5`                                                                        | 73 GB   | игра            | mtime 2025-09-21                      | Перенести на `D:\Games\FarCry5\` или удалить (Ubisoft Connect восстановит) |
| 6  | `C:\Games\Pathfinder Wrath of the Righteous`                                          | 50 GB   | игра            | (под папкой Games)                    | Перенести на `D:\Games\Pathfinder\` (или удалить — RPG прошёл, GOG/Steam восстановят) |
| 7  | `C:\Games\Korabli`                                                                    | 50 GB   | игра (Lesta/WoWS) | (под папкой Games)                  | Перенести на `D:\Games\Korabli\` (онлайн, патчер докачает) |
| 8  | `C:\VirtualPC\WS2022`                                                                 | 31 GB   | VM              | mtime 2026-04-24 (АКТИВНАЯ!)          | НЕ ПЕРЕНОСИТЬ — используется Юджином сейчас                |
| 9  | `C:\Games\Borderlands2`                                                               | 25 GB   | игра            | (под папкой Games)                    | Перенести на `D:\Games\Borderlands2\`                     |
| 10 | `C:\!TMP!\Phone\DCIM` + `C:\!TMP!\Phone\Download` + `C:\!TMP!\Books` (вся папка Phone) | 14 GB   | бэкап телефона  | mtime 2025-03-27 (год назад)          | Перенести на `D:\Backups\Phone-2025-03\` (это явно бэкап Xiaomi-телефона, ему место не на C:) |
| 11 | `C:\Архив загрузок\Разное\Telegram Desktop`                                           | 14 GB   | tg-кэш          | разное (есть свежие 2025-11)          | Сжать `record*.mp4` (40+ файлов крупных видео-записей) и перенести на `D:\OldDownloads\Telegram\`. Часть можно прямо удалить. |
| 12 | `C:\Архив загрузок\Дистрибутивы` (вся папка)                                          | 14 GB   | установщики     | разное, старые .iso/.exe              | Перенести на `D:\OldDownloads\Distributives\`. Топ внутри: `Photos.zip` 2.6 GB (Jun 2025), `Adobe Acrobat ISO` 1.04 GB, `Photos (2).zip` 1 GB, `pycharm-2025.2.exe` 1 GB |
| 13 | `C:\GOG Games\Stellaris`                                                              | 23 GB   | игра            | (вместе с сейвами, см. #18)           | Перенести на `D:\Games\Stellaris\` (GOG Galaxy перенаправится) |
| 14 | `C:\DUMP\posmotreli_dump.sql`                                                         | 24 GB   | SQL-дамп        | (старая БД posmotreli)                | Сжать `xz -9` → ~3-5 GB и перенести на `D:\Archives\posmotreli-dump.sql.xz` (один файл — 7-zip даст крутое сжатие). Или удалить, если уже не актуально. |
| 15 | `C:\Users\elyss\Documents\Paradox Interactive\Stellaris\save games`                   | 26 GB   | сейвы Stellaris | mtime 2024-10-11 (1.5 года назад)     | Перенести на `D:\GameSaves\Stellaris\save games\` (есть симлинк трюк) — забил всю Documents |
| 16 | `C:\Users\elyss\Documents\My Games\Fallout4\Saves`                                    | 21 GB   | сейвы F4        | mtime 2024-10-11, 2507 файлов!         | Перенести на `D:\GameSaves\Fallout4\Saves\`. F4 не запускался с 2021 (по именам сейвов) |
| 17 | `C:\Games\Dispatch Complete`                                                          | 18 GB   | игра            | (под папкой Games)                    | Перенести на `D:\Games\Dispatch\` или удалить                |
| 18 | `C:\Users\elyss\AppData\Local\Larian Studios\Baldur's Gate 3\PlayerProfiles`           | 15 GB   | сейвы BG3       | (с BG3, mtime 2024-10)                | Перенести на `D:\GameSaves\BG3\PlayerProfiles\` (junction back) |
| 19 | `C:\!TMP!\amethyst_global-ota_full-OS3.0.4.0...zip` + распакованная папка             | 11 GB   | OTA Xiaomi      | (~2 копии одного и того же)           | **Удалить** — это .zip и распакованная копия одного OTA-образа. Прошивка телефона уже стоит. |
| 20 | `C:\Users\elyss\AppData\Roaming\Claude\vm_bundles`                                    | 11 GB   | Claude VM       | (растёт сама)                         | Можно очистить через Claude UI. **НЕ удалять руками** (поломает Claude). Кандидат на чистку через приложение. |
| 21 | `C:\Users\elyss\Pictures\FromPhone`                                                   | 12 GB   | фото с телефона | разное (есть 2025-04 свежее)          | Перенести на `D:\Photos\FromPhone-2025\` (1135 файлов JPG). Свежее этого года - оставить. |
| 22 | `C:\Users\elyss\AppData\Local\Yandex\YandexBrowser`                                   | 6.7 GB  | кэш браузера    | живой                                 | **Очистить через UI Yandex.Browser** (Settings → Privacy → Clear browsing data → Cached). НЕ удалять руками. |
| 23 | `C:\Users\elyss\Documents\Electronic Arts\The Sims 4\Mods`                            | 3.9 GB  | моды Sims 4     | mtime 2024-10-11                      | Перенести на `D:\Mods\Sims4\` (junction point обратно) |
| 24 | `C:\Users\elyss\Documents\Electronic Arts\The Sims 4` (без Mods, остальное)            | 1.3 GB  | сейвы+кэш Sims 4 | 2024-10                               | localthumbcache.package (всех 7 копий) можно удалить — пересоздадутся. Сейвы - на D: |
| 25 | `C:\Daggerfall Unity`                                                                 | 6.1 GB  | игра            | mtime 2025-08-10                      | Перенести на `D:\Games\DaggerfallUnity\`                    |
| 26 | `C:\Users\elyss\AppData\Local\Temp` (файлы старше 30 дней)                            | 2.2 GB  | времянки        | разное                                | **Удалить** через Disk Cleanup или вручную старые файлы (winbox64, miflash zip × 2, yabroupdater.tmp, vmware-elyss/ старее 30 дней). 3031 файлов всего. |
| 27 | `C:\Users\elyss\` корень: VMware-VMvisor 8.0U3e (.iso + .rar + .zip + распакованная)   | 1.9 GB  | дубликаты ESXi   | Aug-Oct 2025                          | **Оставить только один формат** (.iso) и перенести на `D:\Archives\ESXi\`. .rar и .zip — дубликаты одного и того же. |
| 28 | `C:\Singularity` + `C:\They Are Billions` + `C:\Diablo II - LoD` + `C:\Valheim` + `C:\Minecraft` + `C:\The Life and Suffering of Sir Brante` + `C:\Battle vs Chess` + `C:\MOO2` | 27 GB суммарно | старые игры | все mtime 2024-2025                  | Перенести на `D:\Games\Legacy\` всю пачку — это раритеты, в которые не играешь |
| 29 | `C:\Архив загрузок\Видео`                                                             | 997 MB  | видеозаписи      | разное (record (40).mp4 727 MB Aug 25) | Перенести на `D:\OldDownloads\Видео\`. 102 файла, в основном grok-video и записи |
| 30 | `C:\Users\elyss\Documents\На выброс`                                                  | 602 MB  | "На выброс"      | mtime 2024-10                         | Юджин сам создал папку «На выброс» и забыл. Перенести на `D:\Trash\` или **удалить** содержимое. |

## Группы по категориям

### Сейвы игр

Все игровые сейвы написаны в 2024-10 или раньше. Юджин с тех пор играет в гораздо более узкий список (WarThunder, Korabli). Топ-кандидаты:

- **Stellaris saves**: `C:\Users\elyss\Documents\Paradox Interactive\Stellaris\save games\` — **26 GB**, 2024-10. Стоит **сразу перенести на D:** + создать junction обратно.
- **Fallout 4 saves**: `C:\Users\elyss\Documents\My Games\Fallout4\Saves\` — **21 GB**, 2507 файлов, последняя дата сохранения в имени файла — 20211120 (3.5 года назад внутри игрового мира). Junction на D:.
- **Baldur's Gate 3**: `%LOCALAPPDATA%\Larian Studios\Baldur's Gate 3\PlayerProfiles` — **15 GB**, 2024-10. Junction на D:.
- **Sims 4 saves**: 528 MB, не критично, но уехать с ними красиво.
- **Cyberpunk 2077**: `C:\Users\elyss\Saved Games\CD Projekt Red\Cyberpunk 2077\` — 242 MB, 2024-10. Можно оставить.
- **Stellaris.rar**: внутри Paradox\Stellaris лежит `save games.rar` 123 MB — это **архив тех же сейвов**. Можно удалить или забрать на D:.
- **FalloutNV** (1.7 GB), **Skyrim** (622 MB), **HoMM5 ToE** (27 MB) — мелочь, в C:\Users\elyss\Documents\My Games\.

### Моды

- **Sims 4 Mods**: `C:\Users\elyss\Documents\Electronic Arts\The Sims 4\Mods` — **3.9 GB**, 58 модов (включая WickedWhims, NisaK Wicked Perversions и пр.). Перенести на D:\Mods\Sims4\.
- **Sims 4 кэш миниатюр**: 7 копий `localthumbcache (N).package` суммарно ~530 MB — **можно удалить**, пересоздаётся.
- **WickedWhimsMod**, **SimModsReject** в `C:\Users\elyss\Documents\Electronic Arts\` — ещё 70-130 MB.
- **The Sims 3**: 1.2 GB рядом, 2024-10. Туда же на D:.
- **Baldur's Gate 3 Mods**: `%LOCALAPPDATA%\Larian Studios\Baldur's Gate 3\Mods` — **1.8 GB**.
- **F4SE / SKSE / NVSE**: маленькие, но если переносишь сейвы, переноси и их.
- В `C:\Users\elyss\Documents\На выброс\TS4 Mod Manager` — 179 MB старого менеджера модов. Можно удалить.

### Времянки

- **`C:\Users\elyss\AppData\Local\Temp`** — **2.2 GB**, 3031 файл. Топ:
  - `vmware-elyss` 759 MB
  - `e822d604-...miflash_pro-en-7.3.706.21.zip.d5a` 221 MB — два дубля одного zip
  - `7b3d4326-...miflash_pro-en-7.3.706.21.zip.d9f` 221 MB — то же
  - `yabroupdater.tmp` 177 MB
  - `wct32DB.tmp` 101 MB, `wct97F7.tmp` 97 MB, `wct1F8D.tmp` 96 MB, `BITE803.tmp` 96 MB
  - **Безопасно удалять** всё, что старше 30 дней через `cleanmgr.exe` (Disk Cleanup) — там встроенный пресет «Temporary Files».
- **`C:\Users\elyss\AppData\Local\CrashDumps`** — 529 MB. Удалить, если не нужны для отладки.
- **`C:\$Recycle.Bin`** — всего 27 MB, не критично, но при чистке **очисти корзину**.
- **`C:\Users\elyss\AppData\Local\Yandex\YandexBrowser` кэш** — 6.7 GB. Очистить через UI браузера, не руками.
- **`C:\Users\elyss\AppData\Local\Google` (Chrome)** — 1.7 GB. Аналогично через UI.
- **`C:\Users\elyss\AppData\Local\go-build`** — 120 MB. `go clean -cache` уберёт. Безопасно.
- **`C:\Users\elyss\AppData\Local\npm-cache`** — 597 MB. `npm cache clean --force`.
- **`C:\Users\elyss\AppData\Local\ms-playwright`** — 677 MB. Кэш браузеров для Playwright. Если не используешь активно — `npx playwright uninstall`.
- **`C:\Users\elyss\AppData\Local\hydralauncher-updater` / `ktalk-updater` / `yandexmusic-updater` / `zalo-updater`** — суммарно ~744 MB остатков от обновлений. Можно удалить руками — это просто старые скачки.
- **Огромный SQL-дамп**: `C:\DUMP\posmotreli_dump.sql` 24 GB — это явно одноразовый дамп БД posmotreli. Сожми (`xz` или `7z` — sql сжимается раз в 5-10) или просто отправь на D:.

### Большие старые файлы (> 500 МБ, > 6 мес)

- `C:\Users\elyss\VMware-VMvisor-Installer-8.0U3e-24677879.x86_64.iso` — 619 MB, Aug 2025
- `C:\Users\elyss\VMware-VMvisor-Installer-8.0U3e-24677879.x86_64.rar` — 595 MB, Oct 2025 (**дубликат iso**)
- `C:\Users\elyss\VMware8.zip` — 612 MB, Oct 2025 (**ещё дубликат**)
- `C:\Users\elyss\VMware8\` — распакованная версия (ещё ~600 MB)
- `C:\Архив загрузок\Дистрибутивы\Photos.zip` — 2.5 GB, Jun 2025
- `C:\Архив загрузок\Дистрибутивы\Photos (1).zip` — 720 MB, Jun 2025 (**серия дубликатов?**)
- `C:\Архив загрузок\Дистрибутивы\Photos (2).zip` — 1 GB, Sep 2025 (**ещё одна копия**)
- `C:\Архив загрузок\Дистрибутивы\Adobe.Acrobat.Pro.DC.2022.x64.Multilingual.iso` — 1.04 GB, May 2022
- `C:\Архив загрузок\Дистрибутивы\pycharm-2025.2.exe` — 980 MB, Aug 2025
- `C:\Архив загрузок\Дистрибутивы\AcrobatXIPro-11.0.6.exe` — 572 MB, Apr 2014 (старпёр)
- `C:\Архив загрузок\Дистрибутивы\Funeralopolis-LastDays.zip` — 550 MB, Aug 2025 (а ещё в `C:\Games\` есть `Funeralopolis-LastDays.zip` 550 MB — **дубликат**)
- `C:\Архив загрузок\Дистрибутивы\Dragon-Center.zip` — 489 MB, Aug 2025
- `C:\Архив загрузок\Разное\Telegram Desktop\record.mp4` — 1 GB, Nov 2025
- `C:\Архив загрузок\Разное\Telegram Desktop\record (14).mp4` — 946 MB, Mar 2025
- `C:\Архив загрузок\Разное\Telegram Desktop\record (10).mp4` — 826 MB, Mar 2025
- ещё ~15 крупных `record*.mp4` в Telegram Desktop (~5-8 GB суммарно)
- `C:\Архив загрузок\Разное\Kimi wa Meido-sama - AniLibria` — 1.3 GB, аниме
- `C:\Архив загрузок\Разное\Castlevania` × 2 (две копии одного и того же по 530 MB)

### Дубликаты (точно или почти точно)

1. **VMware-VMvisor 8.0U3e** в `C:\Users\elyss\` — лежит в **трёх форматах** (.iso, .rar, .zip + распакованная VMware8\) — суммарно ~2.5 GB на одно и то же.
2. **Castlevania-SotN** — две копии: `C:\Архив загрузок\Разное\Castlevania-SotN_[PSX]_(RU)_[f3.1]\` и `Castlevania - Symphony of The Night (rus)\` (плюс соответствующие .7z в Дистрибутивах).
3. **HotA setup** — `HotA_1.7.2_setup.exe` (332 MB, 2025-01) и `HotA_1.7.1_setup.exe` (285 MB, 2024-12) — старая версия не нужна.
4. **Claude Setup.exe** — 4 копии в `C:\Архив загрузок\Дистрибутивы\` (Claude Setup.exe, Claude Setup (1).exe, ..., (3).exe) — оставить одну последнюю.
5. **OTA Xiaomi (amethyst_global)** в `C:\!TMP!\` — `.zip` 5.7 GB и распакованная `amethyst_global-...\` 5.7 GB — **дубликат**.
6. **MiAssistant-4.2.1028.10** — `.zip` 87 MB и распакованная папка 87 MB.
7. **mi_phone_assistant.res_** — `.zip` 1.2 MB и распакованная 2.2 MB.
8. **Photos.zip / Photos (1).zip / Photos (2).zip** в Дистрибутивах — серия с (1)(2) — почти всегда дубликаты.
9. **JDK 21** — `microsoft-jdk-21.0.8-windows-x64.msi` (171 MB) и `jdk-21_windows-x64_bin.msi` (163 MB) — два разных вендора одной версии Java; нужен один.
10. **netgate-installer-amd64.iso.gz** в Разное — 302 MB, Jun 2025; вероятно одноразовый, но проверь.
11. **Stellaris save games.rar** (123 MB) лежит **рядом** с распакованными `save games\` (26 GB). Архив лишний.
12. **Funeralopolis-LastDays.zip** дублируется в `C:\Games\` и в `C:\Архив загрузок\Дистрибутивы\` — оба по 550 MB.

### Странное (нашёл, отмечаю отдельно)

- **`C:\VirtuaGirl`** — 100 GB. Не игра, не VM, не системное. Это танцовщицы-обоинки. Models 94 GB, Models.new 5.6 GB. Это явный кандидат на D: — на C:\ занимает четверть всего свободного и точно не должно жить на системном диске.
- **`C:\DUMP\posmotreli_dump.sql`** — **24 GB SQL-файл**. Это полный дамп старого проекта posmotreli. Сжатый займёт ~3-5 GB. Спросить Юджина — нужен ли вообще.
- **`C:\!TMP!\Phone\`** — на корне C: лежит бэкап Xiaomi-телефона на 14 GB. Папка `C:\!TMP!\` явно создана временно (март 2025), но материал по факту нужный (Books 668 MB, DCIM 11 GB, Download 2 GB).
- **`C:\Singularity` + `C:\Far Cry 5` + `C:\GOG Games` + `C:\Games`** — все игры разбросаны прямо в корне C:, минуя стандартные `C:\Program Files` и Steam-папки. Это сделал сам Юджин — но в плане миграции на D:\ это даже **проще**, потому что нет привязки к Steam-Library.
- **`C:\OLDEM`** — 360 MB. По названию — что-то старое. Туда же на D:\ или на проверку.
- **`C:\Users\elyss\Documents\Command and Conquer Generals Zero Hour Data`** — 2.1 GB. Старая C&C ZH replay/data.
- **`C:\Users\elyss\Documents\На выброс`** — 602 MB. Юджин сам создал и забыл — внутри `Documents.rar` 189 MB, `TS4 Mod Manager` 179 MB, прочее.
- **`C:\Users\elyss\Documents\Медиа\Мои игры`** — 2.6 GB. Что-то игровое в "Медиа".
- **`C:\Users\elyss\OneDrive`** — Я не сканировал глубоко (это синхронизированная папка с облаком, безопасность). Если на C: это «локальная копия» — её можно сделать online-only через настройки OneDrive.
- **`C:\!TMP!\winbox64.exe`** — отдельный файл MikroTik WinBox в TMP, 2.2 MB. Просто рабочий инструмент, оставленный «временно».
- **86Box VMs пустая (277 KB)** в `~/86Box VMs/`. Папка есть, ВМ нет.

## Рекомендации по структуре на D:

```
D:\GameSaves\
├── Fallout4\          (Saves\ + ini-файлы из C:\Users\...\My Games\Fallout4\)
├── Stellaris\         (save games\, settings, dumps)
├── BG3\               (PlayerProfiles\, Mods\)
├── Skyrim\            (Saves\)
├── FalloutNV\         (Saves\)
├── Cyberpunk2077\     (из Saved Games\CD Projekt Red\)
├── Sims4\             (saves\, Tray\)
└── Misc\              (всё остальное мелкое)

D:\Mods\
├── Sims4\             (всё что было в Documents\Electronic Arts\The Sims 4\Mods\)
├── BG3\               (BG3 Mods 1.8 GB)
└── Fallout4\          (если есть отдельные mods вне игры)

D:\Games\              (если оставляешь игры)
├── BG3\               (158 GB)
├── WarThunder\        (137 GB)
├── AtomicHeart\       (120 GB)
├── FarCry5\           (73 GB)
├── Pathfinder\
├── Korabli\
├── Stellaris\
├── Borderlands2\
├── Daggerfall\
├── Legacy\            (Singularity, Diablo II, Valheim, Minecraft, MOO2, BvC, TLAS Brante, TAB)
└── ...

D:\OldDownloads\
├── 2024\
├── 2025\
│   ├── Distributives\ (всё из C:\Архив загрузок\Дистрибутивы)
│   ├── Telegram\      (Telegram Desktop кэш файлов)
│   └── Видео\
└── 2026\

D:\Archives\
├── posmotreli-dump.sql.xz   (сжать SQL-дамп)
├── ESXi\
│   └── VMware-VMvisor-8.0U3e.iso  (только один формат)
├── Phone-2025-03\           (бывший C:\!TMP!\Phone\)
└── ...

D:\Misc\
└── VirtuaGirl\
    └── Models\

D:\Photos\
└── FromPhone-2025\          (~12 GB JPG)
```

В каждой top-level папке полезно создать `README.txt` с датой и происхождением (что откуда уехало).

Симлинк-стратегия (для сейвов и модов, чтобы игры не сломались):
```cmd
mklink /J "C:\Users\elyss\Documents\My Games\Fallout4\Saves" "D:\GameSaves\Fallout4\Saves"
```
(перед этим перенести физически содержимое, а пустую исходную папку удалить).

## Что НЕ трогать ни в коем случае (для верификации)

- `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData` — не сканировал.
- `C:\Users\elyss\.claude\` — память Лары, **критично**.
- `C:\Projects\` — все рабочие проекты Юджина (Iskra, Pixel Classics, Fakel, Prometheus, Editor, Eugene's Archives, Ochag, etc.).
- `C:\Users\elyss\AppData\Local\Microsoft` — 3 GB системных кэшей Windows.
- `C:\Users\elyss\AppData\Roaming\Claude\vm_bundles` — 11 GB Claude SDK; чистить только через UI Claude, **не руками**.
- `C:\VirtualPC\WS2022` — **31 GB ВМ, активно используется** (mtime 2026-04-24, два дня назад). Не трогать.
- `C:\Users\elyss\Saved Games\CD Projekt Red\Cyberpunk 2077\` — 242 MB, можно перенести, но не приоритет.
- `C:\Users\elyss\go\`, `C:\Users\elyss\android-sdk\`, `C:\Users\elyss\gradle-8.4\`, `C:\Users\elyss\.cargo\`, `C:\Users\elyss\.rustup\`, `C:\Users\elyss\.gradle\` — рабочие SDK, не трогать.
- `C:\Users\elyss\OneDrive` — синхронизированная папка с облаком; не сканировал глубоко из осторожности.
- `C:\Users\elyss\Documents\Творчество\` — 271 MB, рукописи. Не трогать (это не мусор, это работа).
- `C:\Users\elyss\Documents\Личные документы\` — 135 MB. Не трогать.
- `C:\Users\elyss\Documents\Работа и карьера\` — 154 MB. Не трогать.
- `C:\Users\elyss\Documents\Совместные статьи (AI)\`, `Творчество\`, `Проекты на будущее\` — рабочее, не трогать.
- `C:\Архив загрузок\Наши статьи (MD)\` — 1.8 MB. Не трогать (наши статьи).
- `C:\Архив загрузок\Пробуждение\` — 248 KB. Не трогать (Лара/Аэлис материалы).
- `C:\Users\elyss\.iskra\`, `.lara\`, `.android\`, `.config\`, `.fly\`, `.railway\`, `.wdc\` — рабочие конфиги.

## Итог

Если выполнить весь план миграции:
- На D: уедет: ~620 GB (игры в C:\Games + GOG\BG3 + Stellaris + Far Cry 5 + Pathfinder + ВЁС VirtuaGirl + остальные старые игры в корне C:\ + сейвы + моды + 12 GB фото + 14 GB Phone + 24 GB DUMP + Telegram Desktop 14 GB + 14 GB Дистрибутивы + 12 GB FromPhone)
- Будет удалено времянок и дублей: ~36 GB (Temp 2.2 GB + дубликаты установщиков и .iso 2.5 GB + дубликат OTA 5.7 GB + браузерные кэши 8.4 GB через UI + сжатие/удаление 24 GB SQL → ~3 GB + кэши обновлений ~700 MB + crash dumps 529 MB)

**Ожидаемый результат на C:** свободно станет ~900-950 GB вместо текущих 304 GB.

Действовать рекомендую в три фазы:
1. **Фаза «лёгкая чистка»** (без потери данных): Temp, корзина, кэши обновлений, дубликаты установщиков, дубликат OTA Xiaomi, дубликаты VMware-iso. Освободит ~25 GB за 30 минут.
2. **Фаза «перенос с симлинками»**: сейвы (F4, Stellaris, BG3, Sims 4) + моды Sims 4. Освободит ~70 GB. Игры продолжат работать через junction.
3. **Фаза «большой переезд»**: вся `C:\Games\`, `C:\GOG Games\`, `C:\Far Cry 5`, `C:\VirtuaGirl`, `C:\!TMP!\Phone`, `C:\DUMP`, `C:\Архив загрузок\Дистрибутивы`. Освободит ~520 GB. Игры будут запускаться с D:\ (никаких симлинков — просто двинь и при первом запуске лаунчер спросит «где она»).
