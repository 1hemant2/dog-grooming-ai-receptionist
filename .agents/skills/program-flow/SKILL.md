---
name: program-flow
description: Capture, refine, and analyze program requirements and conversation flows before implementation. Use when the user defines, changes, reviews, or analyzes application behavior. Do not implement application code until the user explicitly asks to begin implementation.
---

# Program Flow

Use [references/requirements.md](references/requirements.md) as the source of truth for agreed program behavior.

## Define the flow

When the user describes a conversation flow:

1. Add or update the relevant flow in the reference file.
2. Preserve the user's business language and intent.
3. Separate confirmed behavior from assumptions and open questions.
4. Identify missing decisions only when they change observable behavior or design.
5. Do not create application code, project scaffolding, schemas, or integrations during this stage.

Describe each flow with only the sections it needs:

- Trigger
- Preconditions
- Main flow
- Alternate and failure flows
- Required information and validation
- External reads and writes
- Human handoff conditions
- Final outcome
- Open questions

## Analyze the flow

When asked to analyze, check the conversation flows for:

- Missing paths and unclear outcomes
- Conflicting rules or duplicated behavior
- Ambiguous dates, identities, state transitions, or ownership
- Unsafe or irreversible actions without confirmation
- External failures and retry behavior
- Information that must persist between interactions
- Boundaries that should become domain objects, services, or interfaces during implementation

Report findings in plain language. Recommend the smallest decision that resolves each issue, and update the reference only after the user confirms a material behavior change.

## Begin implementation

Implement code only when the user explicitly asks to start implementation. Before coding:

1. Read the complete requirements reference and repository `AGENTS.md`.
2. List unresolved questions that materially affect the architecture or behavior.
3. Translate confirmed conversation flows into a small low-level design and meaningful tests.
4. Keep implementation traceable to the documented flows without adding speculative behavior.
