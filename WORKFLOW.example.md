---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: my-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate

polling:
  interval_ms: 30000

workspace:
  root: ~/sympho_workspaces

hooks:
  after_create: |
    git clone "$REPO_URL" . 2>/dev/null || true
    git checkout -b "sympho/{{ issue.identifier }}" 2>/dev/null || true
  before_run: |
    git fetch origin main 2>/dev/null || true
    git rebase origin/main 2>/dev/null || true
  after_run: |
    echo "Run completed for {{ issue.identifier }}"

agent:
  command: claude --output-format stream-json -p
  max_concurrent_agents: 5
  max_turns: 20
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

You are an autonomous coding agent working on a Linear issue.

## Issue Details

- **Identifier**: {{ issue.identifier }}
- **Title**: {{ issue.title }}
- **State**: {{ issue.state }}
- **Priority**: {{ issue.priority }}
- **URL**: {{ issue.url }}

## Description

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided. Check the issue title and any linked resources.
{% endif %}

{% if issue.labels.size > 0 %}
## Labels
{% for label in issue.labels %}- {{ label }}
{% endfor %}
{% endif %}

{% if issue.blockedBy.size > 0 %}
## Blockers
{% for blocker in issue.blockedBy %}- {{ blocker.identifier }} ({{ blocker.state }})
{% endfor %}
{% endif %}

## Instructions

1. Read the issue carefully and understand the requirements.
2. Explore the codebase to understand the relevant code.
3. Implement the changes needed to resolve this issue.
4. Write or update tests to cover your changes.
5. Run tests to make sure everything passes.
6. Create a commit with a clear message referencing {{ issue.identifier }}.
7. Push the branch and create a pull request.

{% if attempt %}
**Note**: This is retry attempt #{{ attempt }}. Review previous work in this workspace before starting.
{% endif %}
