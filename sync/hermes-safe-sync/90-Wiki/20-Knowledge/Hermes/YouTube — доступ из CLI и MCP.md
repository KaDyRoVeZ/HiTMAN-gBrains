---
type: procedure
title: "YouTube — доступ из CLI и MCP"
status: active
created: 2026-09-16
updated: 2026-09-16
domain: "ai-agents"
tags: [youtube, cli, mcp, yt-dlp, transcripts, hermes, media]
confidence: high
privacy: public
sources: ["live-tool-test-yt-dlp", "live-tool-test-youtube-fetcher", "live-mcp-handshake-sinco-lab"]
source_urls: ["https://github.com/yt-dlp/yt-dlp", "https://www.npmjs.com/package/@sinco-lab/mcp-youtube-transcript", "https://github.com/kimtaeyoon83/mcp-server-youtube-transcript"]
source_paths: ["/Users/kadyrovez/.local/bin/yt-dlp", "/Users/kadyrovez/.config/yt-dlp/config", "/Users/kadyrovez/.hermes/yt-venv", "/Users/kadyrovez/.hermes/skills/media/youtube-fetcher"]
raw_files: []
origin_platform: "hermes"
origin_id: "session-2026-09-16-youtube-cli-mcp"
backlinks: []
related: ["Kanban доска", "Бесплатные модели — Nous portal"]
review: verified
---

# YouTube — доступ из CLI и MCP

Два рабочих пути: локальный CLI (yt-dlp + скилл `youtube-fetcher`) и MCP-сервер как инструмент агента. Ключ API не нужен ни там, ни там. Проверено живыми прогонами 16.09.2026 на видео `aircAruvnKk` (3Blue1Brown, «But what is a neural network?»).

## Когда что брать

- Нужен текст видео, конспект в хранилище, поиск по сказанному — CLI, `youtube-fetcher`. Дешевле и не занимает контекст.
- Нужно, чтобы YouTube был доступен другому агенту или внешнему клиенту как инструмент — MCP-сервер.
- Нужны поиск по чужим каналам, статистика, метаданные — только официальный YouTube Data API v3 (ключ + квота), ни транскриптов, ни скачивания он не даёт.

## Путь 1 — CLI (основной)

### Транскрипты и субтитры

Скилл `youtube-fetcher` (`~/.hermes/skills/media/youtube-fetcher`). Зависимости (`youtube-transcript-api`, `requests`) поставлены в отдельный venv — системный Python 3.9 не годится, PEP 668 закрыт.

```bash
SKILL_DIR=~/.hermes/skills/media/youtube-fetcher
~/.hermes/yt-venv/bin/python "$SKILL_DIR/scripts/fetch_transcript.py" --stdout --timestamps --lang ru,en -- URL
```

Что умеет:

- `--list` — показать дорожки и доступные языки перевода;
- `--lang ru,en` — выбрать существующие субтитры (перевод не делает), `--lang auto` — взять любую, `--strict-lang` — без отката на английский;
- `--translate en` — машинный перевод YouTube, только по явному запросу;
- `--format txt|json|srt|vtt` — экспорт; по умолчанию Markdown-заметка с frontmatter (title, channel, duration, upload_date, language, caption_type);
- `--stdout` — вывод в консоль без записи файла;
- куда пишет: `--output` → `--output-dir` → `YOUTUBE_FETCHER_DIR` → `~/yt_transcripts/`;
- существующий файл не перезаписывает: код выхода `3` = файл сохранён, нужен `--force`.

## Путь 1б — yt-dlp (скачивание и метаданные)

`~/.local/bin/yt-dlp`, версия 2026.08.19. Node v24.21.0 в `~/.local/bin`.

```bash
yt-dlp "URL"                                    # видео
yt-dlp -x --audio-format mp3 "URL"               # только звук
yt-dlp --skip-download --print "%(title)s | %(channel)s | %(duration)s | %(upload_date)s" -- URL
yt-dlp --list-subs --skip-download -- URL
```

Конфиг `~/.config/yt-dlp/config`:

```
--js-runtimes node
--no-mtime
```

Без `--js-runtimes node` каждая команда сыпала `WARNING: No supported JavaScript runtime could be found… some formats may be missing` — YouTube выдаёт часть форматов только через JS-рантайм, по умолчанию yt-dlp ждёт deno. Node уже стоит, поэтому рантайм прописан на него.

Известное ограничение: загрузка субтитров самим yt-dlp отбилась `HTTP Error 429: Too Many Requests` на том же видео, где API-путь прошёл. Для текстов брать `youtube-fetcher`, yt-dlp — для медиа и метаданных.

## Путь 2 — MCP-сервер

В каталоге Nous (`hermes mcp catalog`) YouTube нет — ставится сторонний сервер через npx, без ключа:

```bash
hermes mcp add youtube --command npx --args -y @sinco-lab/mcp-youtube-transcript
hermes mcp test youtube
```

Проверено вручную JSON-RPC-хендшейком (initialize → tools/list → tools/call), сервер `@sinco-lab/mcp-youtube-transcript` v0.0.12, пять инструментов:

| Инструмент | Аргументы |
|---|---|
| `get_transcript` | `url`, `lang`, `enableParagraphs` |
| `get_timed_transcript` | `url`, `lang`, `enableParagraphs` |
| `get_transcripts` | `url`, `lang`, `enableParagraphs` |
| `get_video_info` | `url` |
| `get_available_languages` | `url` |

`tools/call get_video_info` вернул videoId, title и полный список дорожек с признаком `isGenerated`; `get_transcript` — текст с заголовком видео. Альтернативы того же класса: `@kimtaeyoon83/mcp-server-youtube-transcript` (тот же принцип, есть платный TwelveLabs-режим), `@transcriptapi/mcp-server` (нужен API-ключ).

Цена решения: пять инструментов попадают в контекст каждой сессии Hermes. При потребности «дай транскрипт» CLI дешевле, поэтому сервер в Hermes пока **не зарегистрирован**.

## Что не проверено

- Официальный YouTube Data API v3: ключ не заводился, квота 10 000 единиц в сутки и отсутствие транскриптов в API — по документации, живым вызовом не подтверждено.
- MCP-сервер протестирован хендшейком вне Hermes; поведение после `hermes mcp add` (дискавери тулов, лимиты) не проверялось, потому что сервер не регистрировался.

## Обратный путь

- Сессия Hermes: `session-2026-09-16-youtube-cli-mcp` (профиль default, desktop).
- Команды и вывод: проверочные прогоны 16.09.2026 17:05–18:40 +07 — `yt-dlp --version`, список субтитров, `fetch_transcript.py --stdout --timestamps` на `https://youtu.be/aircAruvnKk`, ручной MCP-хендшейк.
- Скилл: `youtube-fetcher` (в него добавлена пометка про venv `~/.hermes/yt-venv`).
- Локальные пути: `/Users/kadyrovez/.local/bin/yt-dlp`, `/Users/kadyrovez/.config/yt-dlp/config`, `/Users/kadyrovez/.hermes/yt-venv`, `/Users/kadyrovez/.hermes/skills/media/youtube-fetcher`.
- Источники по MCP: <https://www.npmjs.com/package/@sinco-lab/mcp-youtube-transcript>, <https://github.com/kimtaeyoon83/mcp-server-youtube-transcript>.

## Журнал изменений

- 2026-09-16 — создано по итогам живой проверки CLI- и MCP-путей доступа к YouTube.
