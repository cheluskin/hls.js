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

Добавлена система **автоматического failback** — при ошибке загрузки фрагмента библиотека автоматически пробует загрузить его с резервных хостов. Список резервных хостов получается динамически из DNS TXT записи или задается статически.

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

В `src/config.ts` определены три типа загрузчиков:

```typescript
{
  loader: XhrLoader,      // Базовый загрузчик для плейлистов и ключей
  fLoader: FailbackLoader, // Fragment Loader - для сегментов видео/аудио
  pLoader: undefined,      // Playlist Loader - можно переопределить
}
```

**`fLoader` (Fragment Loader)** — специализированный загрузчик для медиа-сегментов:

- Используется для `.ts`, `.m4s`, `.aac` сегментов
- Получает конфигурацию из `fragLoadPolicy`
- Наша модификация: по умолчанию `FailbackLoader`

**`pLoader` (Playlist Loader)** — для манифестов и плейлистов:

- Используется для `.m3u8` файлов
- Получает конфигурацию из `playlistLoadPolicy`
- По умолчанию: `undefined` (используется `loader`)

**`loader`** — базовый загрузчик:

- Fallback если `fLoader`/`pLoader` не определены
- По умолчанию: `XhrLoader`

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
│  │ Состояние (глобальное, shared между всеми instances):    │   │
│  │ • consecutiveOriginalFailures: number                     │   │
│  │ • permanentFailbackMode: boolean                          │   │
│  │ • dnsHostsCache: string[]                                │   │
│  │ • fragmentsSinceLastProbe: number                         │   │
│  │ • recoveryVideoElement: HTMLVideoElement | null          │   │
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
- **Детекция зависания (stall detection)** — переключение на резервный хост если нет данных 5 секунд
- **Детекция низкой скорости (throughput detection)** — переключение если скорость < 4KB/s в течение 5 секунд
- **Режим постоянного failback** — после 2 последовательных ошибок на оригинальном источнике, все последующие запросы идут напрямую на резервные хосты
- Дедупликация уже попробованных URL + защитный лимит `MAX_FAILBACK_ATTEMPTS = 32` против циклического `transformUrl`
- Кастомная трансформация URL через callback
- Опциональное подробное логирование через `failbackConfig.verbose`
- Сбор статистики загрузки (timing, bandwidth)
- Прогресс-события

### 2. DNS TXT Resolver (`src/utils/dns-txt-resolver.ts`)

Получение списка резервных хостов из DNS TXT записи через DNS-over-HTTPS.

**Провайдеры DoH:**

1. Google (`dns.google/resolve`)
2. Cloudflare (`cloudflare-dns.com/dns-query`)

**Особенности:**

- Параллельные запросы ко всем провайдерам (первый успешный ответ побеждает)
- Таймаут 3 секунды на каждый провайдер
- `dns-txt-resolver` кеширует TXT-ответы на всю сессию
- `failback-host-resolver` дополнительно держит per-domain promise/cache для `preloadFailbackHosts()` и синхронного чтения
- `clearDnsCache()` очищает обе прослойки кеша через listener

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
   * Опционально вернуть старое поведение с `Cache-Control: no-store`.
   * По умолчанию false, потому что этот заголовок вызывает CORS preflight.
   */
  enableCacheControlHeader?: boolean;

  /**
   * Подробные per-fragment логи.
   * Критичные события (failback, permanent mode, probe, errors) логируются всегда.
   */
  verbose?: boolean;
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

Преимущество DNS-подхода:

- Нет необходимости обновлять клиентский код
- Изменения DNS подхватываются на новой сессии или после явного `clearDnsCache()`
- Поддержка GeoDNS для региональных хостов

---

## Обработка ошибок

FailbackLoader перехватывает следующие ситуации:

1. **HTTP ошибки** (status не в диапазоне 200-299)
2. **Таймауты** (превышение `maxTimeToFirstByteMs` или `maxLoadTimeMs`)
3. **Сетевые ошибки** (network error)
4. **Browser-initiated `206 Partial Content`** при stale cache, когда мы сами не запрашивали `Range`
5. **Зависание загрузки** (strict stall) — нет progress/event более 5 секунд
6. **Низкая скорость** (throughput stall) — скорость < 4KB/s суммарно более 5 секунд

При каждой ошибке:

1. Для timeout/stall активный XHR abort-ится; для HTTP error уже завершившийся XHR просто считается неуспешным
2. Вычисляется следующий кандидат через `transformUrl()` или список `staticHosts`/DNS
3. Кандидаты, которые уже пробовали или которые совпадают с текущим URL, пропускаются
4. Поиск нового URL ограничен `MAX_FAILBACK_ATTEMPTS = 32`, чтобы защититься от циклического `transformUrl`
5. При успехе — данные возвращаются в обычный HLS pipeline
6. Если новых кандидатов больше нет — вызывается `onAllFailed`, затем наружу уходит стандартная HLS ошибка/timeout

### Режим постоянного failback

После **2 последовательных ошибок** на оригинальном источнике, библиотека переключается в **режим постоянного failback**:

- Все новые запросы идут сразу на резервные хосты (минуя оригинальный)
- Это ускоряет загрузку когда оригинальный источник полностью недоступен

```typescript
import Hls, { getFailbackState, resetFailbackState } from '@armdborg/hls.js';

const hls = new Hls();

// Проверка текущего состояния
const state = getFailbackState(hls.config);
console.log(state);
// { consecutiveFailures: 2, permanentMode: true, threshold: 2 }

// Сброс состояния (вернуться к оригинальному источнику)
resetFailbackState(hls.config);
```

### Автоматическое восстановление на основной CDN

Библиотека автоматически пробует вернуться на основной CDN без участия пользователя:

**Как это работает:**

1. Каждые **6 фрагментов** в режиме permanent failback запускается probe основного CDN
2. Выполняется Range-запрос первых 1KB с основного CDN (таймаут 3 сек)
3. Если запрос успешен — переключаемся обратно на основной CDN
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
│  └── Probe 1KB с основного CDN                              │
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

Чтобы не тратить запросы впустую и не зациклиться, loader хранит `triedUrls` и прекращает поиск после `MAX_FAILBACK_ATTEMPTS`.

### 5. Почему throughput stall считает реальное время, а не “1 тик = 1 секунда”

`setInterval()` в браузере может дрейфовать из-за CPU pressure, background tabs и throttling. Поэтому скорость считается через реальный `dt`, а не через предположение “интервал всегда ровно 1000ms”. Это снижает ложные stall-детекты.

### 6. Почему timeout после TTFB теперь clamp-ится и вызывается асинхронно

Если `maxLoadTimeMs` уже исчерпан к моменту прихода первых headers, отрицательный timeout нельзя безопасно использовать как есть. Код:

- вычисляет `remaining = maxLoadTimeMs - ttfb`
- если бюджет уже вышел, ставит timeout на `0ms`
- вызывает его асинхронно, чтобы чисто выйти из текущего `onreadystatechange`

### 7. Почему `abortInternal()` обнуляет `this.loader`, а `getResponseHeader()` завернут в `try/catch`

Это защита от браузерных edge-cases:

- stale async callbacks от старого XHR должны сразу отфильтровываться по `this.loader !== xhr`
- некоторые браузеры бросают `InvalidStateError`, если читать header слишком рано или после невалидного состояния XHR

---

## Логирование

По умолчанию `FailbackLoader` логирует только операционно важные события. Подробные per-request сообщения включаются через `failbackConfig.verbose`.

### Логи по умолчанию

```
[FailbackLoader] DNS hosts loaded for armfb.turoktv.com: host1.com, host2.com
[FailbackLoader] HTTP ERROR:
  status: 503 Service Unavailable
  url: https://cdn.example.com/seg.ts
  attempt: 0
  elapsed: 187ms
  loaded: 0 bytes
[FailbackLoader] FAILBACK: trying host #1: https://host1.com/seg.ts
[FailbackLoader] CACHE RANGE ISSUE DETECTED:
  url: https://cdn.example.com/seg.ts
  status: 206 Partial Content (browser-initiated)
  Content-Range: bytes 15592-15592/2624292
  received: 1 bytes, total: 2624292 bytes
  ACTION: Treating as error, will try failback
[FailbackLoader] Original source stalled - no progress for 5000ms (1/2)
[FailbackLoader] Strict stall detected (no events for 5100ms)
[FailbackLoader] Throughput stall detected (speed 1024 B/s < 4096 B/s for 5000ms)
[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable
[FailbackLoader] PERMANENT FAILBACK MODE - skipping original, using: https://host1.com/seg.ts
[FailbackLoader] SUCCESS via failback #1: https://host1.com/seg.ts
[FailbackLoader] ALL FAILED: no more failback hosts available
```

### Recovery probe

```
[FailbackLoader] Recovery skipped - probe already in progress
[FailbackLoader] Probing original CDN: https://origin.example.com/seg.ts
[FailbackLoader] Probe xhr starting: https://origin.example.com/seg.ts
[FailbackLoader] Probe response: status=206, success=true
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
[FailbackLoader] LOAD START: https://cdn.example.com/seg.ts
  state: failures=0/2, permanentMode=false
  hosts: [host1.com, host2.com]
  config: stallTimeout=5000ms, minSpeed=4096B/s, probeEvery=6frags
[FailbackLoader] LOADING: https://cdn.example.com/seg.ts
  attempt: 0
  timeout: 5000ms (ttfb=5000ms, maxLoad=30000ms)
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

- **Standalone failback тесты (41):** DNS resolver, URL transformation, state management, exports
- **Integration тесты (26):** Полные сценарии failback, recovery, xhrSetup, IPv6, host:port, late DNS resolution race

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
