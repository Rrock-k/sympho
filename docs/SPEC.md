# Спецификация сервиса Sympho

Статус: Черновик v1
Основано на: [Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md)

## 1. Постановка задачи

Sympho — длительно работающий сервис-автоматизатор, который непрерывно читает задачи из issue-трекера,
создаёт изолированное рабочее пространство для каждой задачи и запускает сессию coding-агента внутри него.

Сервис решает четыре операционные проблемы:

- Превращает выполнение задач в повторяемый daemon-workflow вместо ручных скриптов.
- Изолирует выполнение агента в per-issue workspace — команды агента работают только внутри директории задачи.
- Хранит политику workflow в репозитории (`WORKFLOW.md`) — команда версионирует промпт и конфигурацию вместе с кодом.
- Обеспечивает наблюдаемость для управления и отладки параллельных запусков агентов.

Важная граница:

- Sympho — планировщик/раннер и читатель трекера.
- Запись в трекер (смена статусов, комментарии, ссылки на PR) выполняется coding-агентом через инструменты, доступные в workflow.
- Успешный запуск может завершиться на workflow-определённом состоянии (например `Human Review`), а не обязательно `Done`.

### Отличия от оригинального Symphony

| Аспект | Symphony (OpenAI) | Sympho |
|--------|-------------------|--------|
| Язык | Elixir | TypeScript / Node.js |
| Агент | Codex (app-server JSON-RPC) | claude-code (CLI, `--output-format stream-json`) |
| Режим | Только standalone | Standalone (private) + arena-адаптер (community) |
| Трекер | Linear | Linear + GitHub Issues (абстрактный интерфейс) |
| Шаблоны | Liquid (Solid) | Liquid (liquidjs) |

## 2. Цели и не-цели

### 2.1 Цели

- Поллить issue-трекер на фиксированной частоте и диспатчить работу с ограничением конкурентности.
- Поддерживать единое авторитетное состояние оркестратора для диспатча, ретраев и реконсиляции.
- Создавать детерминированные per-issue workspace и сохранять их между запусками.
- Останавливать активные запуски при изменении состояния задачи.
- Восстанавливаться после транзиентных ошибок с экспоненциальным backoff.
- Загружать runtime-поведение из `WORKFLOW.md` в репозитории.
- Обеспечивать operator-visible наблюдаемость (минимум — структурированные логи).
- Поддерживать восстановление после рестарта без persistent database.

### 2.2 Не-цели

- Веб-UI или мультитенантный control plane.
- Универсальный workflow engine или распределённый job scheduler.
- Встроенная бизнес-логика для редактирования тикетов, PR или комментариев.
- Навязывание конкретной модели sandbox/approval — реализация определяет свою позицию.

## 3. Обзор системы

### 3.1 Основные компоненты

1. **Workflow** — читает `WORKFLOW.md`, парсит YAML front matter + prompt body, возвращает `{config, prompt_template}`.
2. **Config** — типизированные getters для конфигурации workflow, валидация через Zod, дефолты, $VAR подстановка.
3. **Tracker** — абстрактный интерфейс для issue-трекера. Адаптеры: Linear, GitHub Issues, Memory (тесты).
4. **Orchestrator** — polling loop, in-memory state, dispatch/retry/stop/release решения.
5. **Workspace** — per-issue директории, lifecycle хуки, path safety.
6. **AgentRunner** — создаёт workspace, рендерит промпт, запускает claude-code, multi-turn loop.
7. **PromptBuilder** — рендерит Liquid-шаблон из WORKFLOW.md с данными issue.
8. **CLI** — точка входа, парсинг аргументов, запуск оркестратора.

### 3.2 Уровни абстракции

1. **Policy Layer** (определяется репозиторием) — `WORKFLOW.md` prompt body, team-specific правила.
2. **Configuration Layer** — парсинг front matter в типизированные settings.
3. **Coordination Layer** — polling, eligibility, concurrency, retries, reconciliation.
4. **Execution Layer** — workspace lifecycle, agent subprocess protocol.
5. **Integration Layer** — адаптеры трекеров (Linear, GitHub Issues).
6. **Observability Layer** — логи + опциональный status surface.

### 3.3 Внешние зависимости

- API issue-трекера (Linear / GitHub).
- Локальная файловая система для workspace и логов.
- Git CLI для workspace population (через хуки).
- `claude` CLI с поддержкой `--output-format stream-json`.
- Аутентификация для трекера и агента (env vars).

## 4. Доменная модель

### 4.1 Сущности

#### 4.1.1 Issue

Нормализованная запись задачи:

- `id` (string) — стабильный внутренний ID трекера
- `identifier` (string) — человекочитаемый ключ (`ABC-123`)
- `title` (string)
- `description` (string | null)
- `priority` (number | null) — меньше = приоритетнее
- `state` (string) — текущее состояние в трекере
- `branchName` (string | null)
- `url` (string | null)
- `labels` (string[]) — нормализованы к lowercase
- `blockedBy` (BlockerRef[]) — каждый: `{id, identifier, state}`
- `createdAt` (Date | null)
- `updatedAt` (Date | null)

#### 4.1.2 WorkflowDefinition

- `config` (object) — YAML front matter root
- `promptTemplate` (string) — markdown body после front matter, trimmed

#### 4.1.3 ServiceConfig (типизированное представление)

- poll interval, workspace root, active/terminal states
- concurrency limits, agent settings, hooks

#### 4.1.4 Workspace

- `path` — абсолютный путь
- `workspaceKey` — sanitized issue identifier
- `createdNow` — boolean, для гейтинга `after_create` хука

#### 4.1.5 RunAttempt

- `issueId`, `issueIdentifier`, `attempt`, `workspacePath`
- `startedAt`, `status`, `error`

#### 4.1.6 RetryEntry

- `issueId`, `identifier`, `attempt`, `dueAtMs`, `timerHandle`, `error`

#### 4.1.7 OrchestratorState

- `pollIntervalMs`, `maxConcurrentAgents`
- `running` (Map<issueId, RunningEntry>)
- `claimed` (Set<issueId>)
- `retryAttempts` (Map<issueId, RetryEntry>)
- `completed` (Set<issueId>)
- `agentTotals` (aggregate tokens + runtime seconds)

### 4.2 Нормализация идентификаторов

- **Issue ID** — для lookup и ключей map
- **Issue Identifier** — для логов и именования workspace
- **Workspace Key** — `identifier.replace(/[^A-Za-z0-9._-]/g, '_')`
- **Normalized State** — `.toLowerCase().trim()`

## 5. Спецификация WORKFLOW.md

### 5.1 Обнаружение файла

1. Явный путь через CLI аргумент.
2. По умолчанию: `WORKFLOW.md` в текущей рабочей директории.

### 5.2 Формат файла

Markdown файл с опциональным YAML front matter:

```markdown
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states: [Todo, In Progress]
polling:
  interval_ms: 30000
workspace:
  root: ~/sympho_workspaces
hooks:
  after_create: |
    git clone $REPO_URL . || true
    git checkout -b $ISSUE_BRANCH
agent:
  max_concurrent_agents: 5
  max_turns: 20
---

Ты работаешь над задачей из Linear.

Идентификатор: {{ issue.identifier }}
Заголовок: {{ issue.title }}

Описание:
{% if issue.description %}
{{ issue.description }}
{% else %}
Описание не предоставлено.
{% endif %}
```

Правила парсинга:
- Если файл начинается с `---`, парсить до следующего `---` как YAML front matter.
- Остаток — prompt body.
- Без front matter — весь файл = prompt body, конфиг пустой.
- YAML front matter должен декодироваться в объект; не-объект = ошибка.

### 5.3 Схема Front Matter

#### 5.3.1 `tracker`

- `kind` (string, required) — `"linear"` | `"github"` | `"memory"`
- `endpoint` (string) — default для linear: `https://api.linear.app/graphql`
- `api_key` (string | $VAR) — `$LINEAR_API_KEY` / `$GITHUB_TOKEN`
- `project_slug` (string) — required для linear
- `repo` (string) — required для github (`owner/repo`)
- `active_states` (string[]) — default: `["Todo", "In Progress"]`
- `terminal_states` (string[]) — default: `["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]`

#### 5.3.2 `polling`

- `interval_ms` (number) — default: `30000`

#### 5.3.3 `workspace`

- `root` (string) — default: `<tmpdir>/sympho_workspaces`

#### 5.3.4 `hooks`

- `after_create` (string | null) — при создании workspace
- `before_run` (string | null) — перед каждым запуском агента
- `after_run` (string | null) — после каждого запуска
- `before_remove` (string | null) — перед удалением workspace
- `timeout_ms` (number) — default: `60000`

#### 5.3.5 `agent`

- `command` (string) — default: `claude --output-format stream-json -p`
- `max_concurrent_agents` (number) — default: `10`
- `max_turns` (number) — default: `20`
- `max_retry_backoff_ms` (number) — default: `300000`
- `max_concurrent_agents_by_state` (Record<string, number>) — default: `{}`
- `turn_timeout_ms` (number) — default: `3600000` (1 час)
- `stall_timeout_ms` (number) — default: `300000` (5 мин)

### 5.4 Контракт шаблона промпта

- Рендеринг через Liquid (liquidjs), strict mode.
- Неизвестные переменные — ошибка рендеринга.

Входные переменные:
- `issue` — все поля нормализованной задачи
- `attempt` (number | null) — null для первого запуска

### 5.5 Динамическая перезагрузка

- Следить за изменениями `WORKFLOW.md`.
- При изменении — перечитать и применить без рестарта.
- Невалидный reload не крашит сервис — работаем с последним валидным конфигом.

## 6. Оркестрация

### 6.1 Состояния Issue (внутренние, не трекерные)

1. **Unclaimed** — не запущена, нет retry.
2. **Claimed** — зарезервирована (Running или RetryQueued).
3. **Running** — worker task существует.
4. **RetryQueued** — worker не запущен, retry timer ждёт.
5. **Released** — claim снят (terminal, non-active, missing).

### 6.2 Poll Loop

При старте: валидация конфига → startup cleanup → немедленный tick → повтор каждые `polling.interval_ms`.

Последовательность tick:
1. Реконсиляция running issues.
2. Dispatch preflight validation.
3. Fetch candidate issues.
4. Сортировка по приоритету.
5. Dispatch eligible issues.

### 6.3 Правила выбора кандидатов

Issue dispatch-eligible если:
- Есть `id`, `identifier`, `title`, `state`.
- State в `active_states` и не в `terminal_states`.
- Не в `running` и не в `claimed`.
- Глобальные и per-state слоты доступны.
- Для `Todo`: нет non-terminal блокеров.

Сортировка: `priority` asc → `createdAt` oldest → `identifier` lexicographic.

### 6.4 Retry и Backoff

- Нормальное завершение: retry через `1000ms` (continuation).
- Ошибка: `delay = min(10000 * 2^(attempt-1), max_retry_backoff_ms)`.

### 6.5 Реконсиляция

Каждый tick:
- **Stall detection**: если `elapsed > stall_timeout_ms` → kill + retry.
- **State refresh**: fetch текущих states для running issues. Terminal → stop + cleanup. Active → обновить snapshot.

## 7. Workspace

### 7.1 Layout

- Root: `workspace.root`
- Per-issue: `<root>/<sanitized_identifier>`
- Workspace переиспользуется между запусками.

### 7.2 Хуки

- `after_create` — failure = fatal для создания
- `before_run` — failure = fatal для текущего attempt
- `after_run` — failure ignored
- `before_remove` — failure ignored

Выполнение: `sh -lc <script>`, cwd = workspace, timeout = `hooks.timeout_ms`.

### 7.3 Safety Invariants

1. Агент запускается только в workspace path.
2. Workspace path строго внутри workspace root (prefix check).
3. Workspace key содержит только `[A-Za-z0-9._-]`.

## 8. Agent Runner Protocol

### 8.1 Запуск агента

В отличие от Symphony (JSON-RPC app-server), Sympho использует claude-code CLI:

```bash
claude --output-format stream-json -p "<rendered_prompt>"
```

- Working directory: workspace path
- stdout: stream-json (NDJSON с событиями)
- stdin: не используется в первом повороте, continuation через повторный запуск

### 8.2 Stream-JSON протокол

claude-code с `--output-format stream-json` выдаёт NDJSON:

```json
{"type": "system", "subtype": "init", ...}
{"type": "assistant", "subtype": "text", "content": "..."}
{"type": "tool_use", ...}
{"type": "tool_result", ...}
{"type": "result", "subtype": "success", "cost_usd": 0.05, "session_id": "...", ...}
{"type": "result", "subtype": "error", "error": "...", ...}
```

Completion conditions:
- `{"type": "result", "subtype": "success"}` → success
- `{"type": "result", "subtype": "error"}` → failure
- Turn timeout → failure
- Process exit без result → failure

### 8.3 Multi-turn loop

Для каждого issue AgentRunner:
1. Создаёт/переиспользует workspace.
2. Рендерит промпт.
3. Запускает claude CLI.
4. Стримит события, трекает tokens.
5. По завершении turn — проверяет state в трекере.
6. Если active — запускает continuation turn (до `max_turns`).

Continuation prompt:
```
Предыдущий turn завершился нормально, но задача всё ещё в активном состоянии.
Это continuation turn #N из M.
Продолжай с текущего состояния workspace, не начинай заново.
```

### 8.4 Восстановление сессии

claude-code поддерживает `--resume` для продолжения сессии. AgentRunner сохраняет `session_id` из result и использует его для continuation:

```bash
claude --output-format stream-json --resume <session_id> -p "<continuation_prompt>"
```

## 9. Tracker Integration

### 9.1 Требуемые операции

```typescript
interface Tracker {
  fetchCandidateIssues(): Promise<Issue[]>
  fetchIssuesByStates(states: string[]): Promise<Issue[]>
  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>
}
```

### 9.2 Linear Adapter

- GraphQL API, `Authorization: Bearer <token>`
- Фильтрация по `project.slugId`
- Пагинация, page size = 50, timeout = 30s

### 9.3 GitHub Issues Adapter (будущее)

- REST API v3 или GraphQL v4
- Фильтрация по labels / milestones
- State mapping: open → active, closed → terminal

### 9.4 Memory Adapter

- In-memory хранилище для тестов
- Programmatic API для создания/обновления issues

## 10. Prompt Construction

### 10.1 Входные данные

- `workflow.promptTemplate`
- Нормализованный `issue` объект
- `attempt` (number | null)

### 10.2 Рендеринг

- Liquid (liquidjs) в strict mode.
- Ключи issue конвертируются в strings для template compatibility.
- Nested arrays/maps (labels, blockers) сохраняются для итерации в шаблоне.

## 11. Наблюдаемость

### 11.1 Логирование

- Structured logging (pino).
- Обязательные поля: `issueId`, `issueIdentifier` для issue-related логов.
- `key=value` формат для стабильного парсинга.

### 11.2 Token Accounting

- Извлекать usage из stream-json событий.
- Аккумулировать aggregate totals в состоянии оркестратора.

## 12. Arena Adapter (future)

Для интеграции с agents-arena, отдельный модуль:

- Маппит arena init → sympho issues
- Читает specs/ → issue descriptions
- Пишет `.arena/progress.json` из состояния оркестратора
- Стримит логи → arena log endpoint
- Отправляет terminal report при завершении

Контракт arena runner:
- `GET /init` → получить specs, repo, secrets
- `POST /project-progress` → push progress
- `POST /logs` → push log chunks
- `POST /terminal` → final state report

## 13. Модель ошибок

### 13.1 Классы ошибок

1. **Workflow/Config** — missing file, invalid YAML, unsupported tracker
2. **Workspace** — creation failure, hook timeout, invalid path
3. **Agent Session** — turn failed, timeout, process exit
4. **Tracker** — API errors, auth failures
5. **Observability** — log sink failures

### 13.2 Восстановление

- Config errors → skip dispatch, keep alive, continue reconciliation
- Worker failures → retry с exponential backoff
- Tracker errors → skip tick, retry next tick
- Log failures → don't crash orchestrator

### 13.3 Restart Recovery

- In-memory state, нет persistent DB.
- При рестарте: startup cleanup (terminal workspaces) → fresh poll.
