## Backend (Slim V1)

### Layout

- `app/main.py`: FastAPI app factory
- `app/routers/calibration.py`: calibration HTTP + websocket endpoints
- `core/camera_service.py`: shared 3-camera owner with background capture loops + mode lock
- `core/calibration_manager.py`: per-camera calibrator manager
- `calibration/calibration.py`: ported calibrator class (used with ellipse/radial scoring)
- `calibration/ellipse_calibration.py`: ported ellipse/radial calibration + scoring

### Calibration Path

- `ellipse/radial` only

### Calibration Files

Saved per camera under:

- `backend/data/calibration/camera_0/`
- `backend/data/calibration/camera_1/`
- `backend/data/calibration/camera_2/`

Files include:

- `dartboard_calibration.json` (ellipse/radial)
- `dartboard_calibration.npz` (homography compatibility/front-on)

### Run

```bash
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

Single-runner options:

```bash
python backend/run_api.py
python backend/run_api.py --reload
python backend/run_api.py --with-detector
```

### Websocket Contract

- `ws://localhost:8000/ws/camera/{camera_index}`: binary JPEG stream
- `ws://localhost:8000/ws/events`: JSON status stream

### Camera Ownership

- Camera devices are opened once by `CameraService`.
- Calibration and detection read shared latest frames from the same service.
- Mode lock (`idle|calibration|detection`) is available to coordinate pipelines.
