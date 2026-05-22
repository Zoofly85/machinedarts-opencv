# ADR-001: Single Core, Multi-Shell Product Strategy

## Status
Accepted

## Context
Machine Darts now has multiple product experiences:
- Home
- Club Board (kiosk)
- Club Master (operator)

Maintaining separate repos/build logic for each would increase drift and maintenance risk in critical domains like detection, scoring, and game rules.

## Decision
Use one shared codebase and core domain, with:
- Product flavor builds (`home`, `club-board`, `club-master`)
- Shell-specific UI routing
- Capability-based authorization from backend session/entitlements

## Consequences
### Positive
- Faster bug fixes across all editions
- Consistent gameplay and detection quality
- Lower long-term maintenance cost

### Tradeoffs
- Requires strict module boundaries and capability checks
- Requires discipline to avoid shell-specific logic leaking into core services

## Guardrails
1. No edition branching in core game/detection logic.
2. All privileged actions require server-side capability checks.
3. Shell pages/components live only under their respective module folders.

