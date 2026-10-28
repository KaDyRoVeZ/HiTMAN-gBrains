---
type: concept
title: "Бесплатные модели — Nous portal"
status: active
created: 2026-09-16
updated: 2026-09-16
domain: "ai-agents"
tags: [hermes, models, free-tier, nous-portal, routing]
confidence: high
privacy: public
sources: ["nous-portal-models", "nous-inference-api", "live-tool-call-test"]
source_urls: ["https://inference-api.nousresearch.com/v1/models", "https://portal.nousresearch.com/models"]
source_paths: ["~/.hermes/config.yaml", "~/.hermes/auth.json"]
raw_files: []
origin_platform: "hermes"
origin_id: "session-2026-09-16-free-models"
backlinks: []
related: ["Kanban доска"]
review: verified
---

# Бесплатные модели — Nous portal

На портале Nous (тот же провайдер, через который уже работает Hermes) есть 7 моделей с нулевой ценой. Все поддерживают инструменты (tool calling) и reasoning — проверено живыми вызовами напрямую через API и через Hermes.

## Семь бесплатных моделей

| id (в конфиге — `nous/<id>`) | Контекст | Вход | Замечания |
|---|---|---|---|
| `meituan/longcat-2.0:free` | 1M | текст | 48B активных из 1.6T, agentic tool use, №1 по суточной нагрузке |
| `upstage/solar-pro4:free` | 524K | текст | документы, офис, длинные контексты; другой вендор |
| `poolside/laguna-s-2.1:free` | 262K | текст | кодовый агент, 70.2% Terminal-Bench 2.1 |
| `poolside/laguna-xs-2.1:free` | 262K | текст | лёгкий код |
| `stepfun/step-3.7-flash:free` | 262K | текст+фото+видео | единственный мультимодальный; 11B активных |
| `inclusionai/ling-3.0-flash-fin:free` | 262K | текст | финансовая специализация — не как дефолт |
| `inclusionai/ling-3.0-flash-sante:free` | 262K | текст | медицина/здоровье — не как дефолт |

## Текущее подключение

С 2026-09-18 бесплатные модели оставлены только в профиле `history`, без OpenRouter:

```
default  -> nous/upstage/solar-pro4:free
fallback -> nous/meituan/longcat-2.0:free
```

Остальные рабочие профили используют ChatGPT Pro через `openai-codex`. Алиасы `code` и `vision` удалены из `history`, чтобы там остались ровно две бесплатные модели.

См. [[GPT Pro — маршрутизация и пауза автоматизаций]].

## Принципы выбора (см. скилл free-model-routing)

- Free-модель несёт объём, платная решает: исходники и длинные треды не должны входить в контекст платной модели.
- Выбирать по возможностям, а не по месту в лидерборде: сначала tool calling, потом модальность, потом контекст.
- Доменные варианты (Fin, Sante) тянут ответы в свою сторону — только для своей домены.
- Кодовые модели (Laguna) — короткие и code-first, не для общего чата.

## Ограничения (важно)

- Бесплатные варианты часто означают «данные идут в обучение провайдера». Явного подтверждения на портале не нашёл (документация отдаёт 404, страница за Cloudflare). Правило: рабочие документы, почту, финансы и данные по скважинам через free-модели не гонять — для этого остаётся платный `flash` (`nous/deepseek/deepseek-v4-flash-0731`, ~$0.04/1M вход).
- Окно бесплатного доступа конечно: id с суффиксом `:free` может исчезнуть. Алиасы переключаются одной командой.
- Free-уровни лимитированы по частоте и в сутки — массовые параллельные вызовы упираются в потолок.
- Solar Pro 4 в ответе API помечается `is_byok: true` с ненулевым upstream-костом — бесплатность обеспечивает портал, а не отсутствие затрат у провайдера.

## Обратный путь

- Каталог моделей: <https://inference-api.nousresearch.com/v1/models> (публичный)
- Страница с бесплатными: <https://portal.nousresearch.com/models>
- Конфиг: `/Users/kadyrovez/.hermes/config.yaml`
- Скилл: `free-model-routing`
