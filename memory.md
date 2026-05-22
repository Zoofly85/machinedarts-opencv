# Machine Darts Memory

Last updated: 2026-02-20

## Goal
Build a clean new darts app with:
- stable motion-based dart detection
- ellipse/radial calibration scoring
- OpenVINO tip inference + multi-camera vote
- clean backend/frontend split

## Current Status
- Calibration: working
- Dart detection/takeout detection (`dartcounter`): working and stable
- Tip model scoring + vote: working
- Async scoring pipeline: working (keeps detector FPS near 30)
- Settings pages: detection + models working

## Core Backend Structure
- `backend/run_api.py`
  - Starts FastAPI + dartcounter (default)
- `backend/app/main.py`
  - App setup and router registration
- `backend/app/routers/calibration.py`
  - Camera streams, calibration endpoints, calibration detect/save/rotate/score
- `backend/app/routers/detection.py`
  - Detection settings + insights API
- `backend/app/routers/models.py`
  - Model settings API for tip model selection/thresholds
- `backend/core/camera_service.py`
  - Shared 3-camera service + mode lock (`idle|calibration|detection`)
- `backend/core/detection/dartcounter.py`
  - Main motion state machine
- `backend/core/tip_scoring.py`
  - OpenVINO tip inference, per-camera scoring, vote, tip de-dup tracking
- `backend/core/calibration_manager.py`
  - Per-camera calibration manager and score bridge
- `backend/calibration/calibration.py`
  - Calibration orchestration (load/save/overlay/scoring path)
- `backend/calibration/ellipse_calibration.py`
  - Ellipse/radial geometry + point scoring math

## Frontend Structure
- `frontend/src/pages/CalibrationPage.tsx`
- `frontend/src/pages/HomePage.tsx`
- `frontend/src/pages/ConsolePage.tsx` (operator console, live WS)
- `frontend/src/pages/SettingsPage.tsx`
- `frontend/src/pages/DetectionSettingsPage.tsx`
- `frontend/src/pages/ModelsSettingsPage.tsx`
- `frontend/src/services/api.ts`

## Data/Settings Paths
- Calibration data:
  - `backend/data/calibration/camera_0/`
  - `backend/data/calibration/camera_1/`
  - `backend/data/calibration/camera_2/`
- Detection settings:
  - `backend/data/settings/detection.json`
- Model settings:
  - `backend/data/settings/models.json`

## Detection Pipeline (Current)
1. `dartcounter` processes motion diffs at ~30 FPS.
2. Dart event (`dart_detected`) triggers scoring job enqueue.
3. Background worker in `dartcounter` runs tip scoring async.
4. `tip_scoring`:
   - gets tip candidates from selected OpenVINO model
   - scores each camera tip with calibration
   - votes final score (majority, tie-break by confidence)
5. Result logged and pushed into detection insights.

## Important Logic Decisions
- Keep `dartcounter` state machine minimal and stable.
- Tip scoring is async so FPS does not drop during inference.
- Tip de-dup tracking implemented (default 4 px) to avoid rescoring old tips.
- Tip tracks reset on takeout/reset.
- Takeout start logic uses `sum_of_2_smallest(diff)` threshold semantics.
- Finish remove metric in insights now reflects takeout decision metric (mask-overlap style), not raw diff sum.

## Model Handling
- Tip models discovered from `models/tip/*` directories containing `.xml`.
- Supports mixed model input sizes (example: `736x1280`, `1280x1280`).
- Preprocess adapts to selected model shape.
- Batch inference optimization:
  - tries reshape to batch=3 for all camera frames in one infer call
  - falls back to per-frame when needed
- Buffer reuse optimization added for lower per-event overhead.

## Current Known Good Behavior
- Detector FPS generally ~29.7–29.8.
- Tip scoring `proc` latency typically ~240–315 ms (model dependent).
- No major FPS collapse during tip scoring after async + batch changes.

## Current Tuning Notes
- User tested model settings around:
  - confidence threshold: `0.5`
  - IoU threshold: `0.9`
- These help when darts are close and boxes overlap.
- Detection/takeout thresholds are tunable in detection settings UI.

## API Endpoints Added/Used
- Detection settings:
  - `GET /api/settings/detection`
  - `PUT /api/settings/detection`
  - `POST /api/settings/detection/reset`
  - `GET /api/settings/detection/insights`
- Model settings:
  - `GET /api/settings/models`
  - `PUT /api/settings/models`
- Detection events (real-time):
  - `WS /ws/detection/events`
- Calibration/scoring:
  - `POST /api/calibration/detect/{camera_index}`
  - `POST /api/calibration/save/{camera_index}`
  - `POST /api/calibration/rotate`
  - `POST /api/calibration/score`

## Real-Time Detection Event Stream
- Event bus module:
  - `backend/core/detection_events.py`
- Producer:
  - `backend/core/detection/dartcounter.py` publishes events from detection loop and tip worker
- Consumer endpoint:
  - `backend/app/routers/detection.py` websocket `/ws/detection/events`
- Current emitted event types:
  - `state_changed`
    - fields: `from_state`, `to_state`, `darts_on_board`
  - `dart_detected`
    - fields: `detection_counter`, `darts_on_board`
  - `dart_score`
    - fields: `score_value`, `score`, `votes`, `processing_ms`, `total_ms`
  - `dart_score_unavailable`
    - fields: `reason`, `processing_ms`, `total_ms`
  - `takeout_complete`
- Transport details:
  - each event has `seq` and `ts`
  - websocket pushes with ~20ms loop latency

## Remaining Next Steps (Suggested)
- Build operator-first flow around `Console -> Calibration -> Settings`.
- Surface voted score directly into game UI state (consume existing WS events).
- Optional: add vote quality gate (ignore publish when votes < 2).
- Optional: expose duplicate tip pixel threshold in Models page.
- Optional: add light score history/debug panel for backend validation.

## UI Changes (2026-02-21)
- Removed Detection Console from app routes and settings navigation.
- Added `PracticePage` at `/practice` using current WS event stream:
  - connection status
  - detection state
  - darts on board
  - 3-dart turn score boxes + turn total
  - automatic reset on takeout events
- Home already links to `/practice`; now route is active.

## Packaging Notes (2026-02-21)
- Tauri setup completed in `frontend/src-tauri`.
- Fixed Tauri frontend output path to `../dist` for Vite.
- Added Tauri bundle settings:
  - `externalBin`: `binaries/darts-backend`
  - `resources`: `../../models` (correct path from `src-tauri`)
- Updated tip model discovery in `backend/core/tip_scoring.py` to support packaged runtime paths:
  - `MACHINE_DARTS_MODELS_DIR` env override
  - source tree path
  - executable folder + `resources/models/tip`
  - PyInstaller `_MEIPASS`
  - current working directory fallback
- Added backend sidecar lifecycle in `frontend/src-tauri/src/lib.rs`:
  - starts `darts-backend` automatically on app launch
  - searches common install/resource locations
  - kills backend child process on app exit
- Root cause for "backend failed" in packaged app:
  - sidecar exe crashed at startup with `ModuleNotFoundError: No module named 'backend'`
  - fixed by rebuilding backend with spec that sets `pathex=['..']` (project root visible during freeze)
  - reliable rebuild command: `pyinstaller darts-backend.spec` from `backend/`
- Camera feed/detection connectivity fix (desktop runtime):
  - switched frontend backend endpoints from `localhost` to `127.0.0.1` for both HTTP and WS
  - avoids hostname/IPv6 resolution issues that can break websocket camera streams in packaged app
