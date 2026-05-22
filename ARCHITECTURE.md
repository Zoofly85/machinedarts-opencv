# Machine Darts Architecture

## Intent
One shared core platform with separate product shells:
- Home
- Club Board (kiosk)
- Club Master (operator)

## Layer rules
1. Core domain/services (`backend/core`, game logic, detection, scoring) must not branch by product edition.
2. Edition/role gating must go through capability checks (`backend/core/capabilities.py` and frontend capabilities context).
3. Shell-specific UI belongs only in shell modules:
   - `frontend/src/modules/home`
   - `frontend/src/modules/club-board`
   - `frontend/src/modules/club-master`
4. Shared contracts/UI belong in:
   - `frontend/src/modules/shared-domain`
   - `frontend/src/modules/shared-ui`

## Routing and shell ownership
- Home shell owns classic gameplay and settings UX.
- Club Board shell owns walk-up kiosk UX.
- Club Master shell owns venue operations and event dashboards.

## API boundaries
- Existing gameplay APIs remain stable as shared core APIs.
- Club scaffolding is under `/api/club/*`.
- Auth/session/capabilities are under `/api/auth/*`.

## Security and permission rules
- UI hiding is not sufficient.
- Every privileged club operation must be validated server-side by capability.

## Migration policy
- Incremental only.
- New club features go into module structure immediately.
- Legacy pages are moved in small batches; avoid big-bang refactors.

