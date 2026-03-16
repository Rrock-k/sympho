---
tracker:
  kind: github
  api_key: $GITHUB_TOKEN
  repo: Rrock-k/agents-arena
  active_states:
    - Todo
  terminal_states:
    - Done
    - Closed
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ./runtime

hooks:
  after_create: |
    git clone https://github.com/Rrock-k/agents-arena.git .
    git checkout -b by-symphony
  before_run: |
    git fetch origin main 2>/dev/null || true

agent:
  command: claude --output-format stream-json --verbose --dangerously-skip-permissions -p
  max_concurrent_agents: 1
  max_turns: 10
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
---

You are an autonomous coding agent working on a GitHub issue in the agents-arena project.

## Issue Details

- **Number**: {{ issue.identifier }}
- **Title**: {{ issue.title }}
- **State**: {{ issue.state }}
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

## Instructions

1. Read the issue carefully and understand the requirements.
2. Explore the codebase to understand the relevant code.
3. Implement the changes needed to resolve this issue.
4. Write or update tests to cover your changes.
5. Run tests to make sure everything passes.
6. Create a commit with a clear message referencing {{ issue.identifier }}.

{% if attempt %}
**Note**: This is retry attempt #{{ attempt }}. Review previous work in this workspace before starting.
{% endif %}
