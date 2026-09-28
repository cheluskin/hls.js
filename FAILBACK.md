# HLS.js с автоматическим Failback

Форк библиотеки [hls.js](https://github.com/video-dev/hls.js) с добавлением системы автоматического переключения на резервные хосты при загрузке фрагментов видео.

**Пакеты:**

- `@armdborg/hls.js` — DNS: `armfb.turoktv.com`, Fallback: `failback.turkserial.co`
- `@intrdb/hls.js` — DNS: `intfb.turoktv.com`, Fallback: `failback.intrdb.com`

**Репозиторий:** https://github.com/cheluskin/hls.js

---

## Описание доработки

### Проблема

При воспроизведении HLS-потоков CDN-серверы могут временно быть недоступны по различным причинам:

- Блокировка на уровне провайдера
- Технические проблемы на CDN
- Региональные ограничения
- DDoS-атаки

Стандартная библиотека hls.js при ошибке загрузки фрагмента делает повторные попытки на тот же хост, что неэффективно если хост полностью недоступен.

### Решение

Добавлена система **автоматического failback** — при ошибке загрузки фрагмента или плейлиста библиотека автоматически пробует загрузить его с резервных хостов. Список резервных хостов получается динамически из DNS TXT записи или задается статически.

### Как выглядит блокировка ТСПУ (по net-export логам Android)

Разбор `chrome://net-export` логов с Android 15 / Chrome 149 (плеер `armdb.org`, мобильная сеть):

| Хост                                   | Что происходит                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `hls.armdb.org` (nginx)                | Отвечает быстро, но на сегменты отдаёт `302` на `cdnNNN.armdb.org`                                                                             |
| `cdn307/cdn360.armdb.org` (OVH)        | TCP и TLS 1.3 проходят (сервер успевает отдать ~2.7–4 КБ), запрос отправлен — ответа нет никогда. RST нет                                      |
| `failback.turkserial.co` (Cloudflare)  | HTTP/2: то же самое; при TLS-resumption проходят заголовки `200` и ~1.3 КБ тела, потом тишина. HTTP/3 (QUIC): рукопожатие ~7 КБ, дальше тишина |
| DoH `dns.google`, `cloudflare-dns.com` | Работают (ответы маленькие)                                                                                                                    |

Итого: ТСПУ пропускает несколько первых КБ от сервера (рукопожатие, иногда заголовки и начало тела) и дальше молча дропает пакеты сервера. Соединение не рвётся, поэтому браузер его не закрывает.

Важное следствие для плеера: **повтор запроса на тот же хост уходит в тот же замороженный сеанс**. `xhr.abort()` для HTTP/2 шлёт только `RST_STREAM`, TCP-сеанс остаётся в пуле Chrome, и следующий запрос мультиплексируется в него. Chrome убивает такой сеанс только по PING-проверке (PING отправляется, если новый запрос создан ≥10 с после последнего чтения, и ещё 10 с ждётся ответ — в логе `HTTP2_SESSION_CLOSE "Failed ping"` через ~30 с). QUIC-сеанс переиспользуется ещё дольше (idle-таймаут минуты). Поэтому:

- «повторить тот же хост по свежему соединению» после тишины бесполезно — такой хост понижается в приоритете (не исключается) на 30 с, с удвоением до 5 мин при повторных заморозках;
- докачка через Range тоже не спасает: на одно соединение проходит ~1–3 КБ полезных данных;
- спасают только хосты, которые **не** под блокировкой. Если заблокированы все хосты из списка, клиентский код не может доставить видео — нужен хотя бы один резервный хост на незаблокированной у пользователя сети (см. рекомендации ниже).

**Рекомендации для инфраструктуры:**

1. Держать в TXT `armfb.turoktv.com` / `intfb.turoktv.com` **несколько независимых** хостов на разных сетях (разные AS/провайдеры, в т.ч. российский хостинг). Один Cloudflare-хост не является резервом от ТСПУ: IP Cloudflare, OVH, Hetzner и т.п. блокируются именно таким способом.
2. Резервные хосты должны отдавать и сегменты, и плейлисты по тем же путям (`/file/armdb-hls/...`), без редиректа на заблокированные CDN.
3. Если резервный хост за Cloudflare, можно отключить HTTP/3: при заблокированном QUIC Chrome не откатывается на TCP (рукопожатие ведь прошло) и дольше держит мёртвый сеанс. Сам по себе IP Cloudflare при этом остаётся под той же блокировкой.

---

## Архитектура HLS.js Fragment Loading

### Общая архитектура загрузки фрагментов в HLS.js

HLS.js использует многоуровневую систему загрузки медиа-контента:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            HLS Instance                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     StreamController                                 │   │
│  │  Управляет буферизацией, определяет какие фрагменты загружать       │   │
│  └───────────────────────────────┬─────────────────────────────────────┘   │
│                                  │                                          │
│                                  ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     FragmentLoader                                   │   │
│  │  src/loader/fragment-loader.ts                                      │   │
│  │  • Создаёт контекст загрузки (URL, headers, range)                   │   │
│  │  • Управляет жизненным циклом Loader                                 │   │
│  │  • Обрабатывает callbacks (onSuccess, onError, onTimeout)            │   │
│  └───────────────────────────────┬─────────────────────────────────────┘   │
│                                  │                                          │
│              ┌───────────────────┼───────────────────┐                     │
│              │                   │                   │                      │
│              ▼                   ▼                   ▼                      │
│     ┌────────────────┐  ┌────────────────┐  ┌────────────────┐             │
│     │   XhrLoader    │  │  FetchLoader   │  │ FailbackLoader │             │
│     │   (default)    │  │   (optional)   │  │   (failback)   │             │
│     └────────────────┘  └────────────────┘  └────────────────┘             │
│                                                     │                       │
│                                                     │ Наша доработка        │
└─────────────────────────────────────────────────────┼───────────────────────┘
                                                      │
                                                      ▼
                                            ┌─────────────────┐
                                            │  DNS TXT Cache  │
                                            │  Failback Hosts │
                                            └─────────────────┘
```

### Конфигурация загрузчиков

В `src/config.ts` и `src/loader/fragment-loader.ts` определены правила выбора загрузчиков:

```typescript
{
  loader: XhrLoader,      // Базовый загрузчик по умолчанию (для плейлистов, ключей и универсального fallback)
  fLoader: undefined,      // Fragment Loader - для сегментов видео/аудио (динамически разрешается в FailbackLoader)
  pLoader: undefined,      // Playlist Loader - для .m3u8 плейлистов
}
```

**`fLoader` (Fragment Loader)** — специализированный загрузчик для медиа-сегментов:

- Используется для `.ts`, `.m4s`, `.mp4`, `.aac` сегментов.
- Наша автоматическая резолюция (`resolveFragmentLoaderConstructor`):
  1. Если в `HlsConfig` явно задан `fLoader` — используется указанный класс (`fLoader`).
  2. Если разработчик задал кастомный `loader` (например, `FetchLoader` или собственный загрузчик) — `FragmentLoader` использует `loader`.
  3. По умолчанию (когда `loader` остаётся стандартным `XhrLoader`) — `FragmentLoader` автоматически выбирает `FailbackLoader`.
- Тот же выбор использует `CMCDController`: включённый CMCD больше не оборачивает голый `XhrLoader` и не отключает failback. Чтобы CMCD работал поверх failback, ничего дополнительно задавать не нужно. Кастомный `fLoader` по-прежнему оборачивается CMCD as-is.

**`pLoader` (Playlist Loader)** — для манифестов и плейлистов:

- Используется для `.m3u8` файлов.
- По умолчанию: `undefined` (используется `loader`).

**`loader`** — базовый загрузчик:

- Инициализируется как `XhrLoader`. Наследуется плейлистами и ключами, а также используется в качестве fallback.

**Плейлисты (`pLoader`)** резолвятся по тем же правилам (`resolvePlaylistLoaderConstructor`): кастомный `pLoader` или нестандартный `loader` используются как есть, а при стандартном `XhrLoader` мультивариантный, медиа- и rendition-плейлисты грузятся через `FailbackLoader` в отдельном «плейлистном» режиме (отключается `failbackConfig.playlistFailback: false`). Особенности режима:

- origin никогда не пропускается; если он уже дважды подряд не ответил, он запускается **параллельно** с лучшим резервом (гонка), а не с форой;
- плейлист, отданный резервом, возвращается с `response.url` = исходный URL, поэтому относительные ссылки на сегменты остаются на каноническом хосте и дальше идут через обычный сегментный failback (с permanent mode и возвратом на origin);
- ошибки плейлистов не влияют на permanent mode сегментов и не отправляют резерв в карантин (404 на зеркале без плейлиста не мешает брать с него сегменты); в отчёт об ошибке попадает ошибка origin, а не 404 зеркала;
- политика ретраев манифеста (`manifestLoadPolicy.timeoutRetry/errorRetry`) соблюдается так же, как в `XhrLoader`; `getCacheAge()` отдаёт `Age` выигравшего ответа (тайминг live-перезагрузок);
- блокирующие LL-HLS перезагрузки (`_HLS_msn` / `_HLS_part`) не хеджируются: сервер намеренно держит такой ответ.

**Известное ограничение:** AES-ключи (`KeyLoader`) по-прежнему идут через обычный `loader` без failback — обычно их отдаёт API приложения с авторизацией, которого нет на зеркалах.

### Интерфейс Loader

Все загрузчики реализуют единый интерфейс:

```typescript
interface Loader<T extends LoaderContext> {
  stats: LoaderStats; // Статистика загрузки
  context: T | null; // Контекст текущего запроса

  load( // Запуск загрузки
    context: T,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<T>,
  ): void;

  abort(): void; // Отмена текущей загрузки
  destroy(): void; // Освобождение ресурсов

  getCacheAge(): number | null; // HTTP cache age
  getResponseHeader(name: string): string | null;
}

interface LoaderCallbacks<T> {
  onSuccess: (response, stats, context, networkDetails) => void;
  onError: (response, context, networkDetails, stats) => void;
  onTimeout: (stats, context, networkDetails) => void;
  onAbort: (stats, context, networkDetails) => void;
  onProgress?: (stats, context, data, networkDetails) => void;
}
```

### Жизненный цикл загрузки фрагмента

```
1. StreamController определяет следующий фрагмент для загрузки
                    │
                    ▼
2. FragmentLoader.load(fragment) вызывается
   │
   ├── Создаёт LoaderContext из Fragment:
   │   • url: fragment.url
   │   • responseType: 'arraybuffer'
   │   • rangeStart/rangeEnd (если byte-range)
   │   • headers (custom headers)
   │
   ├── Получает LoaderConfiguration из fragLoadPolicy:
   │   • maxTimeToFirstByteMs: 10000
   │   • maxLoadTimeMs: 120000
   │   • (retry отключён, т.к. failback внутри loader)
   │
   └── Инстанциирует Loader:
       const loader = config.fLoader
         ? new config.fLoader(config)     // FailbackLoader
         : new config.loader(config);     // XhrLoader
                    │
                    ▼
3. loader.load(context, config, callbacks)
   │
   ├── [FailbackLoader] Проверяет permanentFailbackMode
   │   • Если true → сразу использует failback хост
   │
   ├── Выполняет HTTP запрос (XMLHttpRequest)
   │   • Устанавливает таймауты
   │   • Запускает stall detection
   │
   └── Обрабатывает результат:
       │
       ├── Успех (200-299):
       │   • Вызывает callbacks.onSuccess
       │   • Обновляет stats (bandwidth, timing)
       │   • [FailbackLoader] Сбрасывает счётчик ошибок
       │
       ├── Ошибка (HTTP error, timeout, network):
       │   • [XhrLoader] Вызывает callbacks.onError
       │   • [FailbackLoader] Пробует следующий failback хост
       │       │
       │       ├── Есть следующий хост → повторяет запрос
       │       └── Хосты исчерпаны → callbacks.onError
       │
       └── Stall detected:
           • [FailbackLoader] Переключается на failback хост
           • Инкрементирует счётчик ошибок
                    │
                    ▼
4. FragmentLoader обрабатывает callback:
   │
   ├── onSuccess → Promise resolve → данные в buffer
   ├── onError → Promise reject → ErrorController
   └── onTimeout → Promise reject → ErrorController
                    │
                    ▼
5. StreamController получает данные или ошибку
   • Успех → передаёт в BufferController для декодирования
   • Ошибка → ErrorController решает: retry, switch quality, fatal
```

---

### Архитектура FailbackLoader

```
┌─────────────────────────────────────────────────────────────────┐
│                     Запрос фрагмента                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FailbackLoader                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Состояние (WeakMap на HlsConfig, изоляция плееров):      │   │
│  │ • consecutiveOriginalFailures: number                     │   │
│  │ • permanentFailbackMode: boolean                          │   │
│  │ • unhealthyFailbackHosts: Map (карантин backup-хостов)    │   │
│  │ • fragmentsSinceLastProbe: number                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│              permanentFailbackMode?                              │
│              ┌───────────────┴───────────────┐                  │
│              ▼                               ▼                   │
│          [true]                          [false]                 │
│              │                               │                   │
│              ▼                               ▼                   │
│   Skip original host              Load from original host        │
│   Use failback #1 directly        https://cdn.example.com        │
│                                              │                   │
│                                    Успех?    │                   │
│                                   ┌──────────┴──────────┐       │
│                                   ▼                     ▼       │
│                               [Да]                  [Нет]       │
│                                 │                      │        │
│                                 │               consecutiveOriginalFailures++
│                                 │                      │        │
│                                 │         >= THRESHOLD (2)?     │
│                                 │         ┌──────────┴──────┐   │
│                                 │         ▼                 ▼   │
│                                 │     [Да]              [Нет]   │
│                                 │         │                 │   │
│                                 │   permanentFailbackMode=true  │
│                                 │         │                 │   │
│                                 │         └────────┬────────┘   │
│                                 │                  │            │
│                                 │                  ▼            │
│                                 │    ┌────────────────────────┐ │
│                                 │    │ Попытка failback #1     │ │
│                                 │    │ host1-from-dns.com      │ │
│                                 │    └────────────────────────┘ │
│                                 │                  │            │
│                                 │        Успех?    │            │
│                                 │       ┌──────────┴──────────┐ │
│                                 │       ▼                     ▼ │
│                                 │   [Да]                  [Нет] │
│                                 │     │                      │  │
│                                 │     │                      ▼  │
│                                 │     │       ┌────────────────────────┐
│                                 │     │       │ Попытка failback #N     │
│                                 │     │       │ hostN-from-dns.com      │
│                                 │     │       └────────────────────────┘
│                                 │     │                      │  │
│                                 │     │            Успех?    │  │
│                                 │     │           ┌──────────┴──────┐
│                                 │     │           ▼               ▼ │
│                                 │     │       [Да]            [Нет] │
│                                 │     │         │                │  │
│  ┌──────────────────────────────┼─────┼─────────┘                │  │
│  │                              │     │                          ▼  │
│  ▼                              │     │                   Ошибка HLS │
│  Успех                          │     │                             │
│  │                              │     │                             │
│  ├── consecutiveOriginalFailures = 0  │                             │
│  │   (если это был original host)     │                             │
│  │                              │     │                             │
│  ├── В permanent mode:          │     │                             │
│  │   fragmentsSinceLastProbe++  │     │                             │
│  │   if >= 6 → tryRecoverToOriginalCDN()                            │
│  │                              │     │                             │
│  └── callbacks.onSuccess()      │     │                             │
└─────────────────────────────────┴─────┴─────────────────────────────┘
```

---

## Компоненты

### 1. FailbackLoader (`src/utils/failback-loader.ts`)

Кастомный загрузчик фрагментов, реализующий интерфейс `Loader<FragmentLoaderContext>`.

**Основные возможности:**

- Автоматический перебор резервных хостов при ошибке
- Поддержка таймаутов и HTTP-ошибок
- Динамический reread списка хостов на каждом failback-кандидате, чтобы поздно завершившийся DNS preload влиял на следующие retry
- **Быстрая детекция blackhole ТСПУ (мягкий first-byte timeout)** — если за `firstByteTimeoutMs` (по умолчанию 2500 мс) не пришло заголовков, попытка считается «подозрительной»: её хост понижается в приоритете, открываются альтернативы, а уже скачанный резерв больше не ждёт её. Сам запрос при этом **не** обрывается до транспортного `maxTimeToFirstByteMs` (10 с для сегментов) или пока его слот не понадобится другому кандидату — на медленной, но рабочей мобильной сети origin ещё может ответить
- **Детекция обрыва после первых байт (data-stall)** — если поток замолчал или трикл < 4KB/s дольше `dataStallTimeoutMs` (по умолчанию 3000 мс), попытка бросается (классический паттерн «несколько байт и тишина»)
- **Staggered-хеджирование (параллельная гонка)** — если ведущий запрос молчит `hedgeDelayMs` (по умолчанию 1200 мс), параллельно открывается следующий кандидат. Заголовки оригинала **не** убивают уже летящий backup: 503 или 200-then-stall на origin оставляют резерв как страховку — но только пока ответ не ушёл дальше окна утечки ТСПУ: когда оригинал прокачал ≥ 64 КБ, параллельные резервы отменяются, чтобы на медленной сети сегмент не качался дважды
- **Адаптивные пороги** — `hedgeDelayMs` и `firstByteTimeoutMs` — это минимумы; при медленном отклике сети (сглаженное время до заголовков) они растягиваются до 2× и 3× этого времени, чтобы здоровый медленный канал не хеджировался и не считался блокировкой
- **Порядок резервных хостов с памятью** — хосты идут в порядке DNS/`staticHosts`, но хост, чьё соединение «замёрзло» (тишина/обрыв, в т.ч. проигравший гонку после ≥ `hedgeDelayMs` тишины), уходит в конец списка на 30 с (удвоение до 5 мин при повторах, сброс после успеха). Так следующий фрагмент сразу идёт на резерв, который реально отвечает
- **Повтор того же хоста — только после разрыва соединения** — после reset/network-ошибки или stall хост повторяется до `silentRetriesPerHost` раз (по умолчанию 2): соединение закрыто, повтор пойдёт по новому. После тишины хост в рамках загрузки не повторяется — Chrome отправил бы повтор в тот же замороженный HTTP/2/QUIC-сеанс. HTTP-ошибки на том же хосте не повторяются
- **Режим постоянного failback** — после 2 обычных ошибок origin либо сразу после подтверждённой неполной передачи, **но только когда резерв реально отдал этот фрагмент**. Если не ответил никто (офлайн, смена сети, полный блэкаут), в резерв никто не переключается — после восстановления связи сразу используется origin
- **Офлайн** — при `navigator.onLine === false` ошибки не засчитываются ни origin, ни хостам, а исчерпание сообщается как `onError` с кодом 0 (как у `XhrLoader`): hls.js ждёт события `online`, а не сжигает мгновенные timeout-ретраи до фатальной ошибки
- **Фоновые паузы таймеров** (сворачивание приложения на Android, заморозка вкладки) не принимаются за stall: пропуск тика монитора > 2 с сдвигает окна тишины
- **Статистика для ABR** — `stats.loading.first`/`loaded`/`total` обновляются во время загрузки по лидирующей попытке, а объект `stats` не подменяется (раньше `frag.stats` оставался нулевым, и ABR получал замеры полосы по 0 байт)
- Дедупликация уже попробованных URL + защитные лимиты `MAX_FAILBACK_ATTEMPTS = 32` и `MAX_TOTAL_ATTEMPTS_PER_LOAD = 24` против циклического `transformUrl` и бесконечных retry при полном блэкауте
- Кастомная трансформация URL через callback
- Опциональное подробное логирование через `failbackConfig.verbose`
- Сбор статистики загрузки (timing, bandwidth)
- Прогресс-события

### 2. DNS TXT Resolver (`src/utils/dns-txt-resolver.ts`)

Получение списка резервных хостов из DNS TXT записи через DNS-over-HTTPS.

**Провайдеры DoH (параллельно, первый успешный ответ побеждает):**

1. Google (`dns.google/resolve`)
2. Cloudflare (`cloudflare-dns.com/dns-query`)
3. Quad9 (`dns.quad9.net:5053/dns-query`)
4. AliDNS (`dns.alidns.com/resolve`)

Список можно переопределить через `failbackConfig.dohProviders` или `setDohProviders()`. Google/Cloudflare часто блокируются там же, где нужен failback, поэтому в дефолте есть дополнительные JSON DoH-эндпойнты с CORS.

**Особенности:**

- Параллельные запросы ко всем провайдерам (первый успешный ответ побеждает)
- Таймаут 3 секунды на каждый провайдер
- `dns-txt-resolver` кеширует успешные TXT-ответы на всю сессию; пустой/ошибочный lookup — на 60 секунд
- `failback-host-resolver` дополнительно держит per-domain promise/cache для `preloadFailbackHosts()` и синхронного чтения
- `clearDnsCache()` очищает обе прослойки кеша через listener (`all`)
- `expireNegativeDnsCache()` сбрасывает только отрицательные DNS-записи и неудавшиеся preload-promise; успешный GeoDNS host-cache не трогает

---

## Использование

### Базовое использование (failback включен по умолчанию)

```typescript
import Hls from '@armdborg/hls.js';

const video = document.getElementById('video');
const hls = new Hls();

hls.loadSource('https://example.com/playlist.m3u8');
hls.attachMedia(video);
```

Failback включен по умолчанию. Настройки зависят от пакета:

| Пакет              | DNS домен           | Fallback хост            |
| ------------------ | ------------------- | ------------------------ |
| `@armdborg/hls.js` | `armfb.turoktv.com` | `failback.turkserial.co` |
| `@intrdb/hls.js`   | `intfb.turoktv.com` | `failback.intrdb.com`    |

### Кастомная конфигурация

```typescript
import Hls, { type FailbackConfig } from '@armdborg/hls.js';

const failbackConfig: FailbackConfig = {
  // Статический список хостов (полностью переопределяет DNS)
  // Поддерживаются host, host:port и bracketed IPv6: [2001:db8::1]:9443
  staticHosts: ['backup1.example.com', 'backup2.example.com:8443'],

  // Подробные per-request логи. По умолчанию false.
  verbose: true,

  // Не использовать backup-хост 30 секунд после timeout/stall/error.
  // По умолчанию 30000. Значение 0 отключает quarantine.
  failbackHostCooldownMs: 30000,

  // Callback при переключении на резервный хост
  onFailback: (originalUrl, failbackUrl, attempt) => {
    console.log(`Failback #${attempt}: ${originalUrl} → ${failbackUrl}`);
  },

  // Callback когда все попытки исчерпаны
  // attempts = original request + все failback attempts
  onAllFailed: (originalUrl, attempts) => {
    console.error(`Все ${attempts} попыток провалились: ${originalUrl}`);
  },
};

const hls = new Hls({ failbackConfig });
```

### Кастомная трансформация URL

```typescript
const hls = new Hls({
  failbackConfig: {
    transformUrl: (url, attempt) => {
      // Кастомная логика формирования URL
      const hosts = [
        'cdn1.example.com',
        'cdn2.example.com',
        'cdn3.example.com',
      ];
      if (attempt >= hosts.length) return null;

      const parsed = new URL(url);
      parsed.host = hosts[attempt];
      return parsed.toString();
    },
  },
});
```

### Предзагрузка DNS

Для оптимальной производительности можно заранее прогреть DNS cache при инициализации приложения:

```typescript
import Hls, { preloadFailbackHosts } from '@armdborg/hls.js';

// Вызвать при старте приложения
await preloadFailbackHosts();

// Позже, при создании плеера, хосты уже закешированы
const hls = new Hls();
```

Важно:

- `FailbackLoader` всё равно запускает `preloadFailbackHosts()` в конструкторе в режиме fire-and-forget. Ручной вызов нужен только чтобы прогреть кеш раньше первого сегмента.
- Loader **не** кеширует список хостов на время жизни одного запроса. Это сделано специально: если DNS успел дорезолвиться после `load()`, но до retry, следующая попытка должна взять свежий GeoDNS-упорядоченный список, а не замороженный fallback.
- Если используется `staticHosts`, DNS полностью игнорируется.

---

## API

### FailbackConfig

```typescript
export interface FailbackConfig {
  /** Переопределить package-specific DNS domain */
  dnsDomain?: string;

  /** Статический список хостов. Если задан, DNS не используется */
  staticHosts?: string[];

  /**
   * Кастомная функция трансформации URL.
   * Получает zero-based индекс кандидата: 0, 1, 2...
   * Должна вернуть новый URL или null, если кандидаты закончились.
   */
  transformUrl?: (url: string, attempt: number) => string | null;

  /** Callback при успешной загрузке. attempt > 0 означает успех через failback */
  onSuccess?: (url: string, wasFailback: boolean, attempt: number) => void;

  /** Callback при переключении на резервный хост. attempt здесь 1-based */
  onFailback?: (
    originalUrl: string,
    failbackUrl: string,
    attempt: number,
  ) => void;

  /** Callback когда все попытки исчерпаны. attempts включает original + failback */
  onAllFailed?: (originalUrl: string, attempts: number) => void;

  /**
   * Время, на которое неуспешный backup-хост исключается из новых фрагментов.
   * По умолчанию 30000ms. 0 отключает исключение.
   */
  failbackHostCooldownMs?: number;

  /**
   * Опционально вернуть старое поведение с `Cache-Control: no-store`.
   * По умолчанию false, потому что этот заголовок вызывает CORS preflight.
   */
  enableCacheControlHeader?: boolean;

  /**
   * Подробные per-fragment логи.
   * Критичные события (failback, permanent mode, probe, errors) логируются всегда.
   */
  verbose?: boolean;

  // ---- Устойчивость к цензуре (ТСПУ/DPI) ----

  /** Включить staggered-хеджирование (параллельную гонку). По умолчанию true. */
  hedge?: boolean;

  /**
   * Задержка перед параллельным запуском следующего кандидата, пока текущий
   * молчит (нет заголовков ответа). Минимум: на медленной сети растягивается
   * до 2× сглаженного времени до заголовков. По умолчанию 1200 мс.
   */
  hedgeDelayMs?: number;

  /**
   * Мягкий порог blackhole: попытка без заголовков дольше этого времени
   * считается заблокированной (хост понижается в приоритете, открываются
   * альтернативы, готовый резерв больше её не ждёт), но обрывается только по
   * транспортному `maxTimeToFirstByteMs` или когда её слот нужен другому
   * кандидату. Минимум: на медленной сети растягивается до 3× времени до
   * заголовков. По умолчанию 2500 мс.
   */
  firstByteTimeoutMs?: number;

  /**
   * Бросить попытку, которая получила первый байт, но затем замолчала
   * (тишина или трикл < 4KB/s) дольше этого времени. По умолчанию 3000 мс.
   */
  dataStallTimeoutMs?: number;

  /** Максимум одновременных запросов на один фрагмент. По умолчанию 3. */
  maxParallelAttempts?: number;

  /**
   * Сколько дополнительных повторов того же URL получает хост в рамках одной
   * загрузки после разрыва соединения (reset/closed) или обрыва потока.
   * После чистой тишины хост не повторяется: браузер отправил бы повтор в тот
   * же замороженный HTTP/2/QUIC-сеанс. HTTP-ошибки на том же хосте не
   * повторяются. По умолчанию 2.
   */
  silentRetriesPerHost?: number;

  /**
   * Применять failback (и детект тишины/обрыва) также к плейлистам
   * (мультивариантный, медиа- и rendition-плейлисты), если не задан свой
   * `pLoader`/`loader`. Резервные хосты должны отдавать плейлисты по тем же
   * путям. По умолчанию true.
   */
  playlistFailback?: boolean;

  /**
   * Переопределить process-wide список DoH-провайдеров для резолва
   * failback-хостов. Пустой/опущенный список оставляет дефолт
   * (Google, Cloudflare, Quad9, AliDNS).
   */
  dohProviders?: string[];
}
```

`FailbackConfig` публично экспортируется из пакета и одновременно встроен в `HlsConfig` как `failbackConfig?: FailbackConfig`.

### Экспортируемые функции

```typescript
// Предзагрузка хостов из DNS для конкретного домена или package default
export async function preloadFailbackHosts(
  dnsDomain?: string,
): Promise<string[]>;

// Получение TXT записей из DNS
export async function fetchDnsTxt(domain: string): Promise<string[]>;

// Низкоуровневое получение failback хостов из DNS
export async function fetchFailbackHosts(domain?: string): Promise<string[]>;

// Очистка DNS кешей resolver/preload слоя
export function clearDnsCache(): void;

// Переопределить / прочитать process-wide список DoH-провайдеров
export function setDohProviders(providers?: string[]): void;
export function getDohProviders(): readonly string[];

// Краткое состояние failback для конкретного HlsConfig
export function getFailbackState(config: HlsConfig): {
  consecutiveFailures: number; // Количество последовательных ошибок
  permanentMode: boolean; // Включён ли постоянный failback
  threshold: number; // Порог для постоянного режима (по умолчанию 2)
};

// Расширенное состояние failback/recovery
export function getExtendedFailbackState(config: HlsConfig): {
  consecutiveFailures: number;
  permanentMode: boolean;
  threshold: number;
  fragmentsSinceLastProbe: number;
  probeEveryNFragments: number;
  lastSuccessfulOriginalUrl: string | null;
  isProbeInProgress: boolean;
};

// Сброс состояния failback (для ручного возврата на основной CDN)
// При выходе из permanent mode счётчик ошибок = threshold - 1, первый фейл вернёт обратно
export function resetFailbackState(config: HlsConfig): void;

// Полный сброс состояния (при уничтожении HLS инстанса)
export function destroyFailbackState(config: HlsConfig): void;
```

### Статический доступ к FailbackLoader

```typescript
import Hls from '@armdborg/hls.js';

const hls = new Hls();

// Класс и state helpers доступны и как named exports, и как static members на Hls
const LoaderCtor = Hls.FailbackLoader;
const state = Hls.getFailbackState(hls.config);
```

---

## Логика замены хоста

При failback заменяется только hostname URL, путь и query-параметры сохраняются:

```
Оригинал:     https://cdn.example.com/video/stream/segment001.ts?token=abc
Failback #1:  https://host1-from-dns.example.com/video/stream/segment001.ts?token=abc
Failback #2:  https://host2-from-dns.example.com/video/stream/segment001.ts?token=abc
```

---

## DNS TXT конфигурация

Для динамического управления списком резервных хостов создайте TXT записи:

| Пакет              | DNS домен           |
| ------------------ | ------------------- |
| `@armdborg/hls.js` | `armfb.turoktv.com` |
| `@intrdb/hls.js`   | `intfb.turoktv.com` |

**Содержимое TXT записи:**

```
backup1.example.com
backup2.example.com
backup3.example.com
```

Каждая строка — отдельный хост. Порядок важен: хосты перебираются последовательно.

Записи, которые не выглядят как HTTP-host (SPF `v=spf1 …`, `google-site-verification=…`, строки с пробелами/запятыми), отбрасываются при нормализации и не тратят failback-попытки.

Преимущество DNS-подхода:

- Нет необходимости обновлять клиентский код
- Изменения DNS подхватываются на новой сессии или после явного `clearDnsCache()`
- Поддержка GeoDNS для региональных хостов
- **Отрицательное кэширование (Negative Caching)**: при недоступности всех DoH-провайдеров пустой результат кешируется на **60 секунд**, а не на всю сессию. Это гасит повторные таймауты DoH на каждом фрагменте, но позволяет позже подхватить GeoDNS-список, если плеер стартовал офлайн или DoH был временно заблокирован. Build-time fallback-хост при этом не записывается в постоянный host-cache.

---

## Форматирование хостов и IPv6

Функция `applyHostToUrl` поддерживает произвольные имена хостов, порты и IPv6 адреса:

- Стандартные домены: `backup1.example.com`
- Хосты с указанием порта: `backup1.example.com:8443`
- Скобочный IPv6: `[2001:db8::1]:9443`
- Нескобочный IPv6: `2001:db8::1` (автоматически оборачивается в скобки `[2001:db8::1]`)

---

## Обработка ошибок

FailbackLoader перехватывает следующие ситуации:

1. **HTTP ошибки** (status не в диапазоне 200-299)
2. **Таймауты** (превышение `maxTimeToFirstByteMs` или `maxLoadTimeMs`)
3. **Сетевые ошибки** (network error)
4. **Browser-initiated `206 Partial Content`** при stale cache, когда мы сами не запрашивали `Range` (даже если `Content-Range` скрыт CORS)
5. **Blackhole ТСПУ (`silent`)** — за `firstByteTimeoutMs` не пришло ни заголовков, ни байт
6. **Обрыв после первых байт (`stall`)** — поток замолчал или трикл < 4KB/s дольше `dataStallTimeoutMs`
7. **Усечённый `200/206` ответ** — тело короче `Content-Length` (обрыв middlebox) или не совпадает с запрошенным byte range. Тело _длиннее_ `Content-Length` не считается ошибкой: так выглядит hidden gzip, когда `Content-Encoding` скрыт CORS.

Классификация ошибок определяет стратегию:

- `silent` / `stall` / `network` (включая XHR `status=0` / CORS) считаются **вероятной цензурой**: хост НЕ уходит в quarantine, параллельно хеджируются другие кандидаты
  - `silent` (тишина до заголовков): хост понижается в приоритете (замороженный сеанс), в рамках текущей загрузки не повторяется
  - `stall` (обрыв после первых байт): хост понижается в приоритете; повтор того же URL возможен только как последний вариант
  - `network` (reset/closed): соединения больше нет, поэтому хост повторяется по новому соединению (до `silentRetriesPerHost` раз)
- `http` / `integrity` считаются **детерминированным отказом сервера**: хост уходит в quarantine на `failbackHostCooldownMs` (только для сегментов) и на том же соединении/хосте не повторяется. 4xx резервного хоста не перетирает уже записанную ошибку origin

При каждой ошибке попытки:

1. Активный XHR этой попытки abort-ится, её таймеры очищаются; остальные параллельные попытки продолжают гонку
2. Ошибка классифицируется (`silent`/`stall`/`http`/`integrity`/`partial`/`network`), обновляется health оригинала и/или quarantine / приоритет backup-хоста согласно правилам выше. В офлайне (`navigator.onLine === false`) ничего не засчитывается
3. Освободившийся слот параллелизма немедленно заполняется следующим кандидатом (`transformUrl()` или `staticHosts`/DNS, замороженные хосты — в конце), затем — очередью повторов после разрыва соединения
4. Кандидаты, которые уже в полёте или в quarantine, пропускаются. Если параллелизм исчерпан, а в полёте есть попытка, молчащая дольше мягкого порога, её слот отдаётся следующему кандидату
5. Общее число запусков на один фрагмент ограничено `MAX_TOTAL_ATTEMPTS_PER_LOAD = 24`, а перебор хостов — `MAX_FAILBACK_ATTEMPTS = 32`
6. При первом валидном ответе данные возвращаются в обычный HLS pipeline, остальные попытки отменяются
7. Если кандидатов и повторов больше нет — вызывается `onAllFailed`; наружу уходит `onError` для `http`/`integrity`, `onError` с кодом 0 в офлайне, иначе `onTimeout`

### Режим постоянного failback

После **2 обычных последовательных ошибок** на оригинальном источнике библиотека переключается в **режим постоянного failback** — в момент, когда резервный хост отдал фрагмент, на котором ошибся origin. Пока резерв ничего не доставил, переключения нет: если не отвечает вообще никто (нет сети, смена сети, полный блэкаут), это не повод уводить здорового пользователя на резервы. Подтверждённая неполная передача переводит в этот режим сразу (при первой же доставке резервом):

- stall после headers/progress
- несовпадение запрошенного Range
- тело короче `Content-Length` при `identity` / без `Content-Encoding` (завершённый обрыв middlebox)

HTTP **4xx** (404, 403, 416, …) **не** включает permanent mode: это ошибка конкретного объекта (дырка в плейлисте, протухший токен), а не CDN. Текущий фрагмент всё равно уходит на failback, но следующие снова пробуют origin. `loadSource()` полностью сбрасывает failback-state, чтобы смена канала/серии не оставляла плеер на backup.

Тело _длиннее_ `Content-Length` не считается ошибкой: так выглядит hidden gzip, когда `Content-Encoding` скрыт CORS.

Если в permanent mode все backup-хосты в карантине, loader не роняет фрагмент сразу: сначала пробует оригинал как last resort, и только если он тоже недоступен — один раз игнорирует карантин. Успешный полный сегмент с оригинала выводит из permanent mode.

- Все новые запросы идут сразу на резервные хосты (минуя оригинальный)
- Это ускоряет загрузку когда оригинальный источник полностью недоступен

Для защиты от TSPU blackhole нужен как минимум **два независимых** backup-хоста (разные SNI/IP/CDN). Один host не даёт альтернативы: после его stall loader корректно вернёт ошибку, а не будет бесконечно повторять ту же пару origin → backup.

```typescript
import Hls, { getFailbackState, resetFailbackState } from '@armdborg/hls.js';

const hls = new Hls();

// Проверка текущего состояния
const state = getFailbackState(hls.config);
console.log(state);
// { consecutiveFailures: 2, permanentMode: true, threshold: 2 }

// Сброс состояния (вернуться к оригинальному источнику и очистить quarantine backup-хостов)
resetFailbackState(hls.config);
```

### Автоматическое восстановление на основной CDN

Библиотека автоматически пробует вернуться на основной CDN без участия пользователя:

**Как это работает:**

1. Каждые **6 фрагментов** в режиме permanent failback запускается probe основного CDN
2. Выполняется Range-запрос 64KiB с основного CDN (хвост последнего успешно загруженного сегмента; сегмент короче 64KiB проверяется целиком), таймаут 5 сек. 64KiB заведомо больше окна, которое ТСПУ пропускает перед заморозкой (2–4 КБ в логах, 16–20 КБ в старых отчётах), поэтому «успешная» проверка на замороженном соединении невозможна
3. Возврат происходит только после `206 Partial Content` и получения **всего** запрошенного диапазона; если CORS открывает `Content-Range`, он также обязан совпадать с запросом. Одних headers или нескольких первых байт недостаточно
4. При первой же ошибке на основном CDN — мгновенно возвращаемся в permanent failback mode

**Защита от проблем:**

- **Параллельные проверки** — блокируются, только одна проверка одновременно
- **Смена состояния во время probe** — при выходе из permanent mode переключение отменяется
- **Auth / custom headers** — probe получает `context.headers`, а при наличии `xhrSetup` переключается на XHR и прогоняет тот же setup-код

```
┌─────────────────────────────────────────────────────────────┐
│  Permanent Failback Mode                                    │
│                                                             │
│  Каждые 6 фрагментов:                                       │
│  └── Проверка полного Range до 64KiB с основного CDN         │
│      ├── Успех → выход из permanent mode                    │
│      │           (первый фейл вернёт обратно)               │
│      └── Провал → остаёмся в permanent mode                 │
└─────────────────────────────────────────────────────────────┘
```

**Автоматическое восстановление включено по умолчанию:**

```typescript
import Hls from '@armdborg/hls.js';

const video = document.getElementById('video');
const hls = new Hls();

hls.attachMedia(video);
hls.loadSource('https://example.com/playlist.m3u8');
```

Recovery probe не требует отдельной ручной привязки video элемента.

---

## Почему реализация устроена именно так

Ниже перечислены не просто фичи, а конкретные инженерные решения, которые важны для понимания текущего кода.

### 1. Почему нет per-loader кеша списка хостов

DNS preload асинхронный. Если первый сегмент начал грузиться до завершения DNS lookup, а оригинальный CDN упал уже после того как DNS успел дорезолвиться, retry должен пойти в **свежий GeoDNS-список**, а не в зашитый fallback. Поэтому `getHosts()` перечитывает текущее sync-состояние на каждом выборе кандидата.

### 2. Почему `Cache-Control: no-store` выключен по умолчанию

Исторически этот заголовок помогал бороться с browser cache range issue, но он провоцирует CORS preflight (`OPTIONS`) и удваивает количество запросов. Текущее дефолтное решение дешевле:

- детектировать неожиданный `206 Partial Content`
- считать его ошибкой
- переключаться на failback

Такой `206` относится к конкретному ответу браузерного cache-layer, а не к health оригинального CDN: для него выполняется failback только текущего запроса, без включения permanent mode.

Если нужно вернуть старое поведение для диагностики, есть `failbackConfig.enableCacheControlHeader = true`.

### 3. Почему появился `verbose`, а часть логов осталась always-on

Per-fragment логи (`LOAD START`, `LOADING`, `RESPONSE HEADERS RECEIVED`, `SUCCESS (direct)`) полезны при отладке, но в production быстро превращаются в шум. Поэтому они спрятаны за `verbose`. При этом критичные операционные события всегда видны:

- смена на failback
- permanent mode
- `HTTP ERROR`, `TIMEOUT`, `NETWORK ERROR`
- `ALL FAILED`
- recovery probe

### 4. Почему retry пропускает дубликаты и ограничен 32 кандидатами

Кастомный `transformUrl()` может вернуть:

- тот же URL, что уже был
- одинаковый URL для разных attempt
- бесконечную последовательность дублей
- исключение (перехват: индекс пропускается, загрузка не зависает)

Чтобы не тратить запросы впустую и не зациклиться, loader хранит `triedUrls` и прекращает поиск после `MAX_FAILBACK_ATTEMPTS`.

### 5. Почему throughput stall считает реальное время, а не “1 тик = 1 секунда”

`setInterval()` в браузере может дрейфовать из-за CPU pressure, background tabs и throttling. Поэтому скорость считается через реальный `dt`, а не через предположение “интервал всегда ровно 1000ms”. Это снижает ложные stall-детекты.

### 6. Почему timeout после TTFB теперь clamp-ится и вызывается асинхронно

Если `maxLoadTimeMs` уже исчерпан к моменту прихода первых headers, отрицательный timeout нельзя безопасно использовать как есть. Код:

- вычисляет `remaining = maxLoadTimeMs - ttfb`
- если бюджет уже вышел, ставит timeout на `0ms`
- вызывает его асинхронно, чтобы чисто выйти из текущего `onreadystatechange`

### 7. Почему уже летящий backup не убивается по заголовкам оригинала

Приоритет origin обеспечивается парковкой (`parkFailbackSuccess` / `consumeParkedSuccess`) и `abortInternal()` только после **валидного тела**. Заголовки сами по себе ничего не доказывают: ТСПУ часто отдаёт 503 или 200 и затем обрывает поток. Если в этот момент abort-ить hedged backup, единственный рабочий кандидат оказывается в `triedFailbackUrls` и фрагмент падает впустую.

`getResponseHeader()` завернут в `try/catch`: некоторые браузеры бросают `InvalidStateError`, если читать header слишком рано или после невалидного состояния XHR.

---

## Логирование

По умолчанию `FailbackLoader` логирует только операционно важные события. Подробные per-request сообщения включаются через `failbackConfig.verbose`.

### Логи по умолчанию

```
[FailbackLoader] DNS hosts loaded for armfb.turoktv.com: host1.com, host2.com
[FailbackLoader] FAILBACK: trying host #1: https://host1.com/seg.ts
[FailbackLoader] UNEXPECTED PARTIAL RESPONSE:
  status: 206 Partial Content
  url: https://cdn.example.com/seg.ts
  Content-Range: bytes 15592-15592/2624292
  ACTION: Treating as a browser/cache error, will try failback
[FailbackLoader] SILENT: no response headers from https://cdn.example.com/seg.ts within 2500ms; trying alternatives (request kept until 10000ms)
[FailbackLoader] ATTEMPT FAILED (silent):
  url: https://cdn.example.com/seg.ts
  isOriginal: true, failback#: 0
  reason: No first byte within 10000ms
  elapsed: 10000ms, loaded: 0 bytes
  state: failures=1, permanentMode=false
[FailbackLoader] ATTEMPT FAILED (stall):
  url: https://cdn.example.com/seg.ts
  reason: Throughput 1024 B/s < 4096 B/s for 3000ms
[FailbackLoader] Original source stalled mid-transfer (2/2) - switching as soon as a failback host delivers
[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable, failback host delivered
[FailbackLoader] PERMANENT FAILBACK MODE - skipping original
[FailbackLoader] PLAYLIST via failback #1: https://host1.com/index.m3u8
[FailbackLoader] SUCCESS via failback #1: https://host1.com/seg.ts
[FailbackLoader] ALL FAILED: no more candidates available
```

### Recovery probe

```
[FailbackLoader] Recovery skipped - probe already in progress
[FailbackLoader] Probing original CDN: https://origin.example.com/seg.ts
[FailbackLoader] Probe xhr starting: https://origin.example.com/seg.ts
[FailbackLoader] Probe response: status=206, bytes=65536/65536, content-range=bytes 2558756-2624291/2624292, success=true
[FailbackLoader] ✓ Original CDN recovered - switching back (first fail will return to permanent)
[FailbackLoader] State reset - will try original source (failures=1, first fail returns to permanent)
[FailbackLoader] ✗ Original CDN still unavailable
[FailbackLoader] Recovery aborted - no longer in permanent mode
```

### Подробные логи (`verbose: true`)

```typescript
const hls = new Hls({
  failbackConfig: {
    verbose: true,
  },
});
```

```
[FailbackLoader] LOAD START (fragment): https://cdn.example.com/seg.ts
  state: failures=0/2, permanentMode=false
  hosts: [host1.com, host2.com]
  config: hedge=true, hedgeDelay=1200ms, firstByte=2500/10000ms, dataStall=3000ms, maxParallel=3
[FailbackLoader] LOADING: https://cdn.example.com/seg.ts
  isOriginal: true, failback#: 0
  inFlight: 1
[FailbackLoader] RESPONSE HEADERS RECEIVED:
  status: 200
  ttfb: 83ms
  requested: https://cdn.example.com/seg.ts
[FailbackLoader] SUCCESS (direct):
  url: https://cdn.example.com/seg.ts
  size: 256.0KB, time: 140ms
  speed: 1828.6KB/s (14.63Mbps)
```

### DNS резолвер

```
[DNS-TXT] Resolved <dns-domain>: host1.com, host2.com
[DNS-TXT] Provider https://cloudflare-dns.com/dns-query failed: Error
[DNS-TXT] Failed to resolve <dns-domain> from all providers
```

---

## Установка

### npm

```bash
# Вариант 1: armdb
npm install @armdborg/hls.js

# Вариант 2: intrdb
npm install @intrdb/hls.js
```

### CDN

```html
<!-- Вариант 1: armdb (DNS: armfb.turoktv.com) -->
<script src="https://cdn.jsdelivr.net/npm/@armdborg/hls.js@latest/dist/hls.min.js"></script>

<!-- Вариант 2: intrdb (DNS: intfb.turoktv.com) -->
<script src="https://cdn.jsdelivr.net/npm/@intrdb/hls.js@latest/dist/hls.min.js"></script>
```

---

## Совместимость

- Полная совместимость с API оригинального hls.js
- Drop-in замена: просто замените `hls.js` на `@armdborg/hls.js`
- Версионирование: `{upstream-version}-failback.{N}`

---

## Релиз новой версии

Публикация в npm выполняется локально через npm scripts.

### Настройка npm авторизации (один раз)

```bash
# Вариант 1: Интерактивный логин
npm login

# Вариант 2: Токен с bypass 2FA
# Создать на https://www.npmjs.com/settings/~/tokens → Granular Access Token
npm config set //registry.npmjs.org/:_authToken=npm_ТВОЙ_ТОКЕН
```

### Безопасный релиз

Рекомендуемый поток теперь разделён на version bump и publish, чтобы безопасно переживать partial publish и повторный запуск.

```bash
# 1. Полная проверка релиза
npm run release:check

# 2. Увеличить версию (`1.6.0-failback.N` → `1.6.0-failback.N+1`)
npm run release:version

# 3. Проверить публикацию без записи в npm
npm run deploy:dry-run

# 4. Опубликовать оба варианта
npm run deploy
```

Для happy-path доступна сокращённая команда:

```bash
npm run release
```

Если один пакет уже успел опубликоваться, а второй упал, повторно запускай `npm run deploy` без нового version bump: `scripts/publish.js` пропустит уже опубликованную версию.

После успешной публикации закоммить изменения версии:

```bash
git add package.json package-lock.json
git commit -m "release: bump failback version"
git push
```

### Раздельный деплой

```bash
# Только сборка (оба варианта)
npm run build

# Только сборка armdb
npm run build:armdb

# Только сборка intrdb
npm run build:intrdb

# Dry-run публикации обоих пакетов
npm run deploy:dry-run

# Деплой только armdb
npm run deploy:arm

# Деплой только intrdb
npm run deploy:int
```

### Структура сборки

```
dist-armdb/    ← @armdborg/hls.js (armfb.turoktv.com)
dist-intrdb/   ← @intrdb/hls.js (intfb.turoktv.com)
```

При публикации скрипт `scripts/publish.js` создаёт `package.json` в папке `dist-*`, наследует metadata/exports из корневого `package.json`, проверяет build artifacts, умеет dry-run и пропускает уже опубликованные версии. Корневой `package.json` меняется только отдельным шагом `npm run release:version`.

### Проверка статуса

```bash
# Проверить опубликованные версии
npm view @armdborg/hls.js dist-tags
npm view @intrdb/hls.js dist-tags
```

---

## Тестирование

```bash
# Все failback тесты
npm test

# Upstream unit suite
npm run test:unit

# Standalone failback тесты
npm run test:failback

# Failback integration тесты
npm run test:failback:integration

# Полный release gate
npm run release:check
```

### Покрытие тестами

- **Upstream Karma Unit тесты (1170+):** Полный тестовый сюит HLS.js (включая CMCD v2, transmuxer, ABR, buffer, audio, subtitle controllers), в том числе блок `TSPU resilience (Android net-export scenarios)` для `FailbackLoader`: замороженный хост уходит в конец очереди, тихий хост не повторяется в тот же сеанс, повтор после reset, медленный origin не обрывается, адаптивные пороги, отмена хеджа после 64 КБ, офлайн, статистика для ABR (`frag.stats`), фоновая пауза таймеров, failback плейлистов (base URL, 404 на зеркале, ретраи манифеста, LL-HLS, `Age`, BOM)
- **Standalone failback тесты (46):** DNS resolver, URL transformation, state management, exports, IPv6 formatting, negative DNS caching с TTL
- **Integration тесты (36):** Полные интеграционные сценарии загрузчика:
  - Базовый failback и обход отказа первого источника
  - Режим постоянного failback и автоматическое зондирование восстановления (probe 64KB Range)
  - Детекция скрытых browser-initiated 206 Partial Content
  - Поддержка `xhrSetup`, bracketed/unbracketed IPv6 и пользовательских `staticHosts`
  - Гонка асинхронного DNS-резолвинга
  - **ТСПУ Blackhole & Hedging**: сокрытие первого запроса с параллельным запуском резервного через `hedgeDelayMs`
  - **ТСПУ Data Stall**: микро-пропускная цензура (трикл < 4KB/s) и таймаут простая `dataStallTimeoutMs`
  - **Повтор после reset, но не после тишины**: хост повторяется по новому соединению после сетевой ошибки, а молчащий хост не отправляется повторно в замороженный сеанс (`silentRetriesPerHost`)
  - **Дифференциация карантина хостов**: отправка серверных ошибок (HTTP 503) в карантин (`failbackHostCooldownMs = 30s`) с сохранением доступности хостов при молчаливой цензуре
  - **Last-resort original**: в permanent mode (включённом после доставки резервом) при карантине всех backup-хостов пробуется оригинал, а не мгновенный отказ фрагмента
  - **Hedged backup survives origin headers**: 503 или 200-then-stall на оригинале не убивает уже летящий backup

---

## Структура файлов доработки

```
src/utils/
├── failback-loader.ts           # Основной загрузчик и session-state orchestration
├── failback-host-utils.ts       # Нормализация host/url rewrite
├── failback-host-resolver.ts    # DNS/preload cache для failback hosts
├── failback-recovery-probe.ts   # Transport для recovery probe
├── dns-txt-resolver.ts          # DNS-over-HTTPS резолвер
└── ...

src/loader/
└── resolve-fragment-loader.ts   # Выбор fLoader/pLoader: FailbackLoader вместо стандартного XhrLoader

src/config.ts             # HlsConfig.failbackConfig + fLoader: FailbackLoader по умолчанию
src/hls.ts                # Hls.FailbackLoader + публичные type exports, включая FailbackConfig
src/exports-named.ts      # Named exports runtime helpers/type exports для ESM entrypoint

scripts/
└── publish.js            # Универсальный publish script (arm/int/all, dry-run, skip already-published)

build-config.js           # Env vars: FAILBACK_DNS_DOMAIN, FAILBACK_HOSTS + upstream feature toggles

dist-armdb/               # Сборка @armdborg/hls.js
dist-intrdb/              # Сборка @intrdb/hls.js

tests/
├── standalone-failback-test.mjs   # Unit тесты
├── integration-failback-test.mjs  # Integration тесты
└── ...
```

---

## Примеры использования

### Мониторинг failback событий

```typescript
const hls = new Hls({
  failbackConfig: {
    onSuccess: (url, wasFailback, attempt) => {
      // Метрика успешной загрузки
      if (wasFailback) {
        analytics.track('hls_failback_success', { url, attempt });
      }
    },
    onFailback: (original, failback, attempt) => {
      // Метрика переключения на резервный хост
      analytics.track('hls_failback', {
        original_url: original,
        failback_url: failback,
        attempt: attempt,
      });
    },
    onAllFailed: (original, attempts) => {
      // Алерт при полном отказе
      alerting.send('HLS all failbacks failed', {
        url: original,
        total_attempts: attempts,
      });
    },
  },
});
```

### Отключение failback

```typescript
import Hls from '@armdborg/hls.js';
import XhrLoader from '@armdborg/hls.js/dist/utils/xhr-loader';

// Использовать стандартный XhrLoader вместо FailbackLoader
const hls = new Hls({
  fLoader: XhrLoader,
});
```

---

## Откат версии

### Через npm CLI

```bash
# Откатить @armdborg latest на предыдущую версию
npm dist-tag add @armdborg/hls.js@1.6.0-failback.6 latest

# Откатить @intrdb latest на предыдущую версию
npm dist-tag add @intrdb/hls.js@1.6.0-failback.6 latest

# Очистить кэш jsDelivr
curl "https://purge.jsdelivr.net/npm/@armdborg/hls.js/dist/hls.min.js"
curl "https://purge.jsdelivr.net/npm/@intrdb/hls.js/dist/hls.min.js"
```

### На оригинальный hls.js

Замените URL скрипта:

```html
<!-- Было (форк) -->
<script src="https://cdn.jsdelivr.net/npm/@armdborg/hls.js/dist/hls.min.js"></script>

<!-- Стало (оригинал) -->
<script src="https://cdn.jsdelivr.net/npm/hls.js/dist/hls.min.js"></script>
```

---

## Синхронизация с upstream hls.js

Этот форк периодически нужно синхронизировать с оригинальным [video-dev/hls.js](https://github.com/video-dev/hls.js) для получения исправлений и новых функций.

### Первоначальная настройка (один раз)

```bash
git remote add upstream https://github.com/video-dev/hls.js.git
```

### Процесс синхронизации

```bash
# 1. Получить последние изменения из upstream
git fetch upstream

# 2. Убедиться что вы на master
git checkout master

# 3. Смержить изменения upstream
git merge upstream/master

# 4. Разрешить конфликты если есть
#    - Сохранить свою версию (с суффиксом -failback)
#    - Принять изменения upstream для остального кода
git add .
git commit -m "Merge upstream hls.js changes"

# 5. Задеплоить новую версию
npm run deploy

# 6. Закоммитить и запушить
git add -A && git commit -m "Sync with upstream + 1.6.0-failback.N" && git push
```

### Разрешение конфликтов версии

При конфликте в `package.json` сохраняйте свой формат версии:

```json
"version": "X.Y.Z-failback.N"
```

Где X.Y.Z = версия upstream, N = номер вашего патча.

---

## Лицензия

Apache-2.0 (как и оригинальный hls.js)
