# HLS.js с автоматическим Failback

Форк библиотеки [hls.js](https://github.com/video-dev/hls.js) с добавлением системы автоматического переключения на резервные хосты при загрузке фрагментов видео.

**Пакет:** `@armdborg/hls.js`
**Версия:** 1.6.0-failback.8
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

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                     Запрос фрагмента                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FailbackLoader                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Загрузка с основного хоста                           │   │
│  │    https://cdn.example.com/video/segment.ts             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                    Успех?    │                                   │
│                   ┌──────────┴──────────┐                       │
│                   ▼                     ▼                       │
│               [Да]                  [Нет]                       │
│                 │                      │                        │
│                 ▼                      ▼                        │
│         Возврат данных    ┌────────────────────────┐           │
│                           │ Попытка failback #1     │           │
│                           │ host1-from-dns.com      │           │
│                           └────────────────────────┘           │
│                                        │                        │
│                              Успех?    │                        │
│                             ┌──────────┴──────────┐             │
│                             ▼                     ▼             │
│                         [Да]                  [Нет]             │
│                           │                      │              │
│                           ▼                      ▼              │
│                   Возврат данных    ┌────────────────────────┐ │
│                                     │ Попытка failback #N     │ │
│                                     │ hostN-from-dns.com      │ │
│                                     └────────────────────────┘ │
│                                                  │              │
│                                        Успех?    │              │
│                                       ┌──────────┴──────────┐   │
│                                       ▼                     ▼   │
│                                   [Да]                  [Нет]   │
│                                     │                      │    │
│                                     ▼                      ▼    │
│                             Возврат данных         Ошибка HLS   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Компоненты

### 1. FailbackLoader (`src/utils/failback-loader.ts`)

Кастомный загрузчик фрагментов, реализующий интерфейс `Loader<FragmentLoaderContext>`.

**Основные возможности:**

- Автоматический перебор резервных хостов при ошибке
- Поддержка таймаутов и HTTP-ошибок
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

Failback включен по умолчанию с настройками:

- **DNS домен:** `fb.turoktv.com`
- **Fallback хост:** `failback.turkserial.co` (если DNS недоступен)

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

Для динамического управления списком резервных хостов создайте TXT запись:

**Домен:** `fb.turoktv.com` (или ваш кастомный)

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

При каждой ошибке:

1. Текущий запрос прерывается
2. Генерируется URL с следующим failback хостом
3. Выполняется новый запрос
4. При успехе — данные возвращаются
5. При исчерпании всех хостов — стандартная ошибка HLS

---

## Логирование

FailbackLoader выводит в консоль информативные сообщения:

```
[FailbackLoader] DNS hosts loaded: host1.com, host2.com
[FailbackLoader] https://cdn.example.com/seg.ts failed (503), trying: https://host1.com/seg.ts
[FailbackLoader] https://host1.com/seg.ts timeout, trying: https://host2.com/seg.ts
```

```
[DNS-TXT] Resolved fb.turoktv.com: host1.com, host2.com
[DNS-TXT] Provider dns.gcore.com failed: Error
[DNS-TXT] Failed to resolve fb.turoktv.com from all providers
```

---

## Установка

### npm

```bash
npm install @armdborg/hls.js
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/@armdborg/hls.js@latest/dist/hls.min.js"></script>
```

---

## Совместимость

- Полная совместимость с API оригинального hls.js
- Drop-in замена: просто замените `hls.js` на `@armdborg/hls.js`
- Автоматическая синхронизация с upstream (daily)
- Версионирование: `{upstream-version}-failback.{N}`

---

## Структура файлов доработки

```
src/utils/
├── failback-loader.ts    # Основной загрузчик с failback
├── dns-txt-resolver.ts   # DNS-over-HTTPS резолвер
└── ...

src/config.ts             # fLoader: FailbackLoader (строка 414)
src/hls.ts                # Hls.FailbackLoader (строка 79)
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
# Откатить latest на предыдущую версию
npm dist-tag add @armdborg/hls.js@1.6.0-failback.6 latest

# Очистить кэш jsDelivr
curl "https://purge.jsdelivr.net/npm/@armdborg/hls.js/dist/hls.min.js"
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

## Лицензия

Apache-2.0 (как и оригинальный hls.js)
