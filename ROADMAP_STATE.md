# Roadmap State (Living Handoff)

## Last updated
2026-03-16

## Platform status
- [x] Product flavor config in frontend (`home`, `club-board`, `club-master`)
- [x] Shell bootstrap added (HomeShell, ClubBoardShell, ClubMasterShell)
- [x] Backend auth/session capability scaffold (`/api/auth/*`)
- [x] Backend club API scaffold (`/api/club/*`)
- [x] Shared module baselines created
- [x] Architecture guardrail docs added
- [x] Club APIs moved from in-memory scaffold to SQLite persistence
- [x] Club Board heartbeat endpoint + board shell heartbeat client

## Club board/master snapshot (paused point)
- [x] Club board kiosk home/setup/session flow working
- [x] Saved player profile flow wired in club kiosk
- [x] Session timeout behavior present (15 min inactivity)
- [x] Social Night planner UI (club master): groups, fixtures, standings, playoff generation
- [x] Social Night persistence in SQLite (`plan_json`, `results_json`, `playoffs_json`)
- [x] Board queue endpoint: `GET /api/club/boards/{board_id}/next-match`
- [x] Board queue result endpoint: `POST /api/club/boards/{board_id}/results`
- [x] Kiosk `Ready` launches queued match with player handicap start scores (X01)
- [x] Board auto-result submit from stats pages for `x01` and `cricket`
- [x] Social Night mode restricted to `x01` and `cricket` only
- [x] Club-board stats pages show submit status and auto-return to queue

## Active focus now
- Home version stability/performance on older/smaller CPUs.
- Primary target: dartcounter reliability and detection consistency under weak CPU load.

## Next tasks
1. (Home) Profile weak CPU behavior and tune dartcounter path (frame handling, polling load, thresholds on low-power hosts).
2. (Home) Add a low-power preset and benchmark checklist for OV2710/OV9732 + weaker PCs.
3. (Club) Add board status lifecycle in master (`queued`, `ready`, `in_game`, `submitted`, `waiting_next`).
4. (Club) Add robust retry/ack for board result submission and queue advancement.
5. (Club) Expand club rankings and profile stats pages (first-9, avg to 170, checkout %, 40+/60+/80+/100+).
6. Add real auth provider integration (replace scaffold login behavior).
7. Add event-level active-play metrics (separate from occupancy totals).

## Open decisions
- Final auth identity provider for club deployments.
- Cloud data backend for club venue/event persistence.
- Tauri release naming/versioning policy per flavor.

## Resume checklist for club later
1. Start backend and frontend in `club-master` + `club-board` modes.
2. Verify social night lifecycle on 2 boards: plan -> ready -> play -> auto-submit -> next match.
3. Validate round completion and playoff generation from accumulated results.
4. Confirm tablet portrait layout and kiosk-only controls before wider rollout.
