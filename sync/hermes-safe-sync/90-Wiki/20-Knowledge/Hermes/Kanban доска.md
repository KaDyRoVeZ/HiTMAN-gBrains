---
type: concept
title: "Hermes Kanban — доска задач агентов"
status: active
created: 2026-09-16
updated: 2026-09-16
domain: "ai-agents"
tags: [hermes, kanban, multi-agent, dispatcher, lifecycle]
confidence: high
privacy: public
sources: ["hermes-kanban-docs", "hermes-kanban-live-demo"]
source_urls: ["https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban"]
source_paths: ["/Users/kadyrovez/.hermes/kanban.db", "~/.hermes/kanban.db"]
raw_files: []
origin_platform: "hermes"
origin_id: "session-2026-09-16-kanban-demo"
backlinks: []
related: ["Бесплатные модели — Nous portal", "Hermes профили и бесплатные модели"]
review: verified
---

# Hermes Kanban — доска задач агентов

Доска задач, общая для всех профилей Hermes. Каждая задача — строка в SQLite (`~/.hermes/kanban.db`). Воркер — отдельный OS-процесс со своей рабочей папкой, памятью и инструментами.

## Ключевая идея

Задача — не подзадача внутри сессии, а строка в базе. Её подхватывает **диспетчер шлюза** (каждые 60 секунд обходит доску), забирает задачи со статусом `ready` и поднимает отдельный процесс назначенного профиля. Сессия, которая создала задачу, может завершиться — задача не потеряется.

## Восемь статусов

- **Triage** — заготовка; специализатор доработает формулировку.
- **Todo** — ждёт, пока закроются все родители.
- **Scheduled** — запаркована по времени, проснётся сама.
- **Ready** — готова: родители закрыты, исполнитель назначен, ждёт диспетчера.
- **Running** — процесс исполнителя работает, шлёт heartbeat.
- **Blocked** — нужен человек или другая задача; не провал, разблокируется.
- **Review** — работа сделана, ждёт вердикта проверяющего.
- **Done** — закрыта; summary и события остаются в базе навсегда.

## Два входа в одну базу

| Кто | Как |
|---|---|
| Агент (воркер) | инструментами `kanban_*`: `kanban_comment`, `kanban_heartbeat`, `kanban_block`, `kanban_complete` и др. Консоль не зовёт. |
| Человек / скрипт / cron | `hermes kanban …`, слэш-команда `/kanban …`, дашборд. |

Оба пишут в одну базу — рассинхрона нет.

## Рабочие папки (workspace)

- `scratch` (по умолчанию) — временная папка, удаляется при завершении; артефакты, объявленные через `kanban_complete(artifacts=[...])`, копируются в постоянное хранилище.
- `dir:<path>` — общая папка, сохраняется. Только абсолютный путь.
- `worktree` — git worktree для кодовых задач, сохраняется.

## Зависимости (родитель → ребёнок)

Ребёнок создаётся флагом `--parent` / `parents=[...]`. В момент создания в базу пишется событие `dependency_wait {reason: parent_not_done}`, статус — `todo`. Диспетчер не переведёт ребёнка в `ready`, пока родитель не закрыт. Когда родитель стал `done`, ребёнок получает `promoted` и едет дальше сам. В контекст ребёнка ложится summary родителя (handoff), поэтому разные профили могут передавать друг другу результат без пересчёта.

## Питфоллы

- **Тупик зависимости.** Нельзя вешать вспомогательную карточку как ребёнка на задачу, которую она должна разблокировать: ребёнок ждёт родителя, родитель ждёт ребёнка. Такие карточки делают без `--parent`, id родителя пишут в тело. Развязать — `hermes kanban unlink <parent> <child>`. Система помечает случайный `gated: true` событием, чтобы тупик было видно.
- `delegate_task` — это вызов функции (fork→join), Kanban — очередь с состоянием. Разные примитивы.

## Живое подтверждение (16.09.2026)

Демонстрации на этой доске, все в `done`:

- `t_31fa38c6` — полный цикл одной карточки: created → claimed → spawned → heartbeat ×2 → commented → completed за 107 секунд.
- `t_333e02c9` (research, посчитал SKILL.md = 506) → `t_d478090f` (history, подтвердил 506) — передача результата между профилями через handoff родителя.
- `t_6619034f` (родитель) → `t_388bff3e` (ребёнок) — `dependency_wait`, затем `promoted` после закрытия родителя.

## Обратный путь

- База: `/Users/kadyrovez/.hermes/kanban.db`
- Документация: <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>
- Команды: `hermes kanban list`, `hermes kanban show <id>`
- Профили: `hermes profile list` (18 профилей, см. [[Бесплатные модели — Nous portal]])
