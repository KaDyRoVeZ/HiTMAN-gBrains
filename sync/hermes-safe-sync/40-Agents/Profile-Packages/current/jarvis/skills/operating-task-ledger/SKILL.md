---
name: operating-task-ledger
description: Use when tracking work across HiTMAN profiles.
---

# Единый журнал поручений

Используй `/opt/data/coordination/task_ledger.py` для нетривиальных явных поручений.

## Маршрутизация

- `default`: любой домен.
- `caliber`: только `work`, `general`.
- `assistant`: `personal`, `school`, `general`.
- `dragon`: `school`, `general`.
- `emergency`: `emergency`, `general`.

## Безопасность

Для личной задачи добавляй `--visibility owner-only`. Её текст не попадает в общий JSON и Markdown-отчёт. Никогда не записывай секреты, содержимое почты, персональные документы или данные скважины.

## Команды

```bash
LEDGER="python3 /opt/data/coordination/task_ledger.py"
$LEDGER add --owner <profile> --domain <domain> --title "Безопасное краткое название"
$LEDGER start T-0001
$LEDGER block T-0001 --reason "Короткая причина"
$LEDGER complete T-0001 --result-file /absolute/path/to/artifact
$LEDGER report
```

Создавай запись до работы; при завершении или блокировке меняй статус. Не используй журнал для тривиальных вопросов и коротких ответов.