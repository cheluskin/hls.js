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
- **Детекция зависания (stall detection)** — переключение на резервный хост если нет данных 5 секунд
- **Детекция низкой скорости (throughput detection)** — переключение если скорость < 4KB/s в течение 5 секунд
- **Режим постоянного failback** — после 2 последовательных ошибок на оригинальном источнике, все последующие запросы идут напрямую на резервные хосты
- Кастомная трансформация URL через callback
- Сбор статистики загрузки (timing, bandwidth)
- Прогресс-события

### 2. DNS TXT Resolver (`src/utils/dns-txt-resolver.ts`)

Получение списка резервных хостов из DNS TXT записи через DNS-over-HTTPS.

**Провайдеры DoH:**

1. Gcore (`dns.gcore.com/dns-query`) — основной
2. Google (`dns.google/resolve`) — резервный

**Особенности:**

- Параллельные запросы ко всем провайдерам (первый успешный ответ побеждает)
- Таймаут 3 секунды на каждый провайдер
- Результат кешируется на всю сессию

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
import Hls from '@armdborg/hls.js';

const hls = new Hls({
  failbackConfig: {
    // Статический список хостов (переопределяет DNS)
    staticHosts: ['backup1.example.com', 'backup2.example.com'],

    // Callback при переключении на резервный хост
    onFailback: (originalUrl, failbackUrl, attempt) => {
      console.log(`Failback #${attempt}: ${originalUrl} → ${failbackUrl}`);
    },

    // Callback когда все попытки исчерпаны
    onAllFailed: (originalUrl, attempts) => {
      console.error(`Все ${attempts} попыток провалились: ${originalUrl}`);
    },
  },
});
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

Для оптимальной производительности рекомендуется вызвать предзагрузку DNS при инициализации приложения:

```typescript
import { preloadFailbackHosts } from '@armdborg/hls.js';

// Вызвать при старте приложения
await preloadFailbackHosts();

// Позже, при создании плеера, хосты уже закешированы
const hls = new Hls();
```

---

## API

### FailbackConfig

```typescript
interface FailbackConfig {
  /** DNS домен для получения хостов (по умолчанию: fb.turoktv.com) */
  dnsDomain?: string;

  /** Статический список хостов (переопределяет DNS) */
  staticHosts?: string[];

  /** Кастомная функция трансформации URL */
  transformUrl?: (url: string, attempt: number) => string | null;

  /** Callback при успешной загрузке */
  onSuccess?: (url: string, wasFailback: boolean, attempt: number) => void;

  /** Callback при переключении на резервный хост */
  onFailback?: (
    originalUrl: string,
    failbackUrl: string,
    attempt: number,
  ) => void;

  /** Callback когда все попытки исчерпаны */
  onAllFailed?: (originalUrl: string, attempts: number) => void;
}
```

### Экспортируемые функции

```typescript
// Предзагрузка хостов из DNS
export async function preloadFailbackHosts(): Promise<string[]>;

// Получение TXT записей из DNS
export async function fetchDnsTxt(domain: string): Promise<string[]>;

// Получение failback хостов из DNS
export async function fetchFailbackHosts(domain?: string): Promise<string[]>;

// Очистка DNS кеша
export function clearDnsCache(): void;

// Получение состояния failback (для мониторинга)
export function getFailbackState(): {
  consecutiveFailures: number; // Количество последовательных ошибок
  permanentMode: boolean; // Включён ли постоянный failback
  threshold: number; // Порог для постоянного режима (по умолчанию 2)
};

// Сброс состояния failback (для ручного возврата на основной CDN)
// При выходе из permanent mode счётчик ошибок = 1, первый фейл вернёт обратно
export function resetFailbackState(): void;

// Установка video элемента для автоматического восстановления на основной CDN
// Передайте video для включения, null для отключения
export function setRecoveryVideoElement(video: HTMLVideoElement | null): void;

// Полный сброс состояния (при уничтожении HLS инстанса)
export function destroyFailbackState(): void;
```

### Статический доступ к FailbackLoader

```typescript
// Класс FailbackLoader доступен как статическое свойство
const loader = Hls.FailbackLoader;
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
- Мгновенное переключение на новые хосты
- Поддержка GeoDNS для региональных хостов

---

## Обработка ошибок

FailbackLoader перехватывает следующие ситуации:

1. **HTTP ошибки** (status не в диапазоне 200-299)
2. **Таймауты** (превышение `maxTimeToFirstByteMs` или `maxLoadTimeMs`)
3. **Сетевые ошибки** (network error)
4. **Зависание загрузки** (stall detection) — нет данных более 5 секунд
5. **Низкая скорость** (throughput detection) — скорость < 4KB/s более 5 секунд

При каждой ошибке:

1. Текущий запрос прерывается
2. Генерируется URL с следующим failback хостом
3. Выполняется новый запрос
4. При успехе — данные возвращаются
5. При исчерпании всех хостов — стандартная ошибка HLS

### Режим постоянного failback

После **2 последовательных ошибок** на оригинальном источнике, библиотека переключается в **режим постоянного failback**:

- Все новые запросы идут сразу на резервные хосты (минуя оригинальный)
- Это ускоряет загрузку когда оригинальный источник полностью недоступен

```typescript
import { getFailbackState, resetFailbackState } from '@armdborg/hls.js';

// Проверка текущего состояния
const state = getFailbackState();
console.log(state);
// { consecutiveFailures: 2, permanentMode: true, threshold: 2 }

// Сброс состояния (вернуться к оригинальному источнику)
resetFailbackState();
```

### Автоматическое восстановление на основной CDN

Библиотека автоматически пробует вернуться на основной CDN без участия пользователя:

**Как это работает:**

1. Каждые **6 фрагментов** (~2 минуты при 20-сек фрагментах) в режиме permanent failback проверяется основной CDN
2. Перед проверкой убеждаемся, что буфер видео >= **40 секунд** (достаточно для безопасного переключения)
3. Выполняется Range-запрос первого 1KB сегмента с основного CDN (таймаут 3 сек)
4. Если запрос успешен — переключаемся обратно на основной CDN
5. При первой же ошибке на основном CDN — мгновенно возвращаемся в permanent failback mode

**Защита от проблем:**

- **Seek во время проверки** — буфер проверяется повторно после probe, если упал < 40 сек — переключение отменяется
- **Параллельные проверки** — блокируются, только одна проверка одновременно
- **Недостаточный буфер** — проверка пропускается до накопления буфера

```
┌─────────────────────────────────────────────────────────────┐
│  Permanent Failback Mode                                    │
│                                                             │
│  Каждые 6 фрагментов:                                       │
│  ├── Буфер < 40 сек? → пропускаем проверку                  │
│  └── Буфер >= 40 сек? → probe 1KB с основного CDN           │
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

// setRecoveryVideoElement вызывается автоматически при attachMedia()
hls.attachMedia(video);
hls.loadSource('https://example.com/playlist.m3u8');

// При detachMedia() ссылка на video очищается автоматически
```

**Ручное управление (при необходимости):**

```typescript
import { setRecoveryVideoElement } from '@armdborg/hls.js';

// Отключить автоматическое восстановление
setRecoveryVideoElement(null);

// Или установить другой video элемент
setRecoveryVideoElement(anotherVideo);
```

---

## Логирование

FailbackLoader выводит в консоль информативные сообщения:

```
[FailbackLoader] DNS hosts loaded: host1.com, host2.com
[FailbackLoader] https://cdn.example.com/seg.ts failed (503), trying: https://host1.com/seg.ts
[FailbackLoader] https://host1.com/seg.ts timeout, trying: https://host2.com/seg.ts
[FailbackLoader] Original source stalled - no progress for 5000ms (1/2)
[FailbackLoader] Strict stall detected (no events for 5100ms)
[FailbackLoader] Throughput stall detected (speed < 4096 B/s for 5000ms)
[FailbackLoader] ⚠️ SWITCHING TO PERMANENT FAILBACK MODE - original source unreliable
[FailbackLoader] PERMANENT FAILBACK MODE - skipping original, using: https://host1.com/seg.ts
[FailbackLoader] SUCCESS (permanent failback): https://host1.com/seg.ts [3/6]
[FailbackLoader] SUCCESS via failback #1: https://host1.com/seg.ts
```

**Автоматическое восстановление:**

```
[FailbackLoader] Recovery skipped - buffer 25.3s < 40s required
[FailbackLoader] Recovery skipped - probe already in progress
[FailbackLoader] Probing original CDN (buffer=45.2s)...
[FailbackLoader] ✓ Original CDN recovered - switching back (first fail will return to permanent)
[FailbackLoader] State reset - will try original source (failures=1, first fail returns to permanent)
[FailbackLoader] ✗ Original CDN still unavailable
[FailbackLoader] Recovery aborted - buffer dropped to 15.0s during probe
[FailbackLoader] Recovery aborted - no longer in permanent mode
```

**DNS резолвер:**

```
[DNS-TXT] Resolved fb.turoktv.com: host1.com, host2.com
[DNS-TXT] Provider dns.gcore.com failed: Error
[DNS-TXT] Failed to resolve fb.turoktv.com from all providers
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
- Автоматическая синхронизация с upstream (daily)
- Версионирование: `{upstream-version}-failback.{N}`

---

## Релиз новой версии

Публикация в npm происходит автоматически через GitHub Actions при пуше тега `v*`.
Оба пакета (`@armdborg/hls.js` и `@intrdb/hls.js`) публикуются одновременно.

### Быстрый деплой (одной командой)

```bash
# Закоммитить изменения и выполнить деплой обоих пакетов
git add -A
git commit -m "fix/feat: описание изменений"
npm run deploy
```

Команда `npm run deploy` автоматически:

1. Запускает тесты failback
2. Обновляет версию (создаёт тег `v*`)
3. Собирает оба варианта (`dist-armdb/` и `dist-intrdb/`)
4. Публикует `@armdborg/hls.js`
5. Публикует `@intrdb/hls.js`
6. Пушит изменения и теги в GitHub

### Раздельный деплой

```bash
# Только сборка (оба варианта)
npm run build

# Только сборка armdb
npm run build:armdb

# Только сборка intrdb
npm run build:intrdb

# Деплой только armdb
npm run deploy:armdb

# Деплой только intrdb
npm run deploy:intrdb
```

### Структура сборки

```
dist-armdb/    ← @armdborg/hls.js (armfb.turoktv.com)
dist-intrdb/   ← @intrdb/hls.js (intfb.turoktv.com)
dist/          ← Рабочая папка для npm publish
```

### Что происходит автоматически

После пуша тега `v*` GitHub Actions workflow (`.github/workflows/build-release.yml`):

1. Собирает оба варианта (`npm run build`)
2. Запускает failback тесты
3. Публикует `@armdborg/hls.js` в npm
4. Публикует `@intrdb/hls.js` в npm
5. Создаёт GitHub Release с CDN ссылками для обоих пакетов

### Проверка статуса

```bash
# Проверить статус workflow
gh run list --repo cheluskin/hls.js --limit 3

# Проверить опубликованные версии
npm view @armdborg/hls.js versions --json | tail -3
npm view @intrdb/hls.js versions --json | tail -3
```

---

## Тестирование

```bash
# Все тесты (unit + integration)
npm test

# Только unit тесты
npm run test:failback

# Только integration тесты
npm run test:failback:integration

# Все failback тесты явно
npm run test:failback:all
```

### Покрытие тестами

- **Unit тесты (39):** DNS resolver, URL transformation, state management, exports
- **Integration тесты (18):** Полные сценарии failback, recovery, race conditions

---

## Структура файлов доработки

```
src/utils/
├── failback-loader.ts    # Основной загрузчик с failback и CDN recovery
├── dns-txt-resolver.ts   # DNS-over-HTTPS резолвер
└── ...

src/config.ts             # fLoader: FailbackLoader (строка 414)
src/hls.ts                # Hls.FailbackLoader (строка 79)
src/exports-named.ts      # Экспорты функций failback

scripts/
└── publish-intrdb.js     # Скрипт публикации @intrdb/hls.js

build-config.js           # Env vars: FAILBACK_DNS_DOMAIN, FAILBACK_HOSTS

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

### Через GitHub Actions (рекомендуется)

1. Перейдите в репозиторий: https://github.com/cheluskin/hls.js
2. Откройте вкладку **Actions**
3. Слева выберите **"Rollback npm version"**
4. Нажмите **"Run workflow"**
5. Введите версию для отката (например: `1.6.0-failback.6`)
6. Нажмите **"Run workflow"**

Workflow автоматически переключит тег `latest` и очистит кэш jsDelivr.

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
