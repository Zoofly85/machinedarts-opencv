# Machine Darts Game Frontend

Browser gameplay frontend, kept separate from the backend control app.

Purpose:
- player-facing home page
- game select
- lobby flow
- game pages
- profiles and gameplay stats

Not included here:
- backend console
- calibration
- model select
- backend detection settings
- backend admin/stats pages

Expected backend:
- local backend API on `http://localhost:8000`

Typical dev flow:
```powershell
cd game-frontend
npm install
npm start
```

Backend app remains in:
- `frontend/`

This folder is the clean place to adapt the old gameplay UI to the current backend websocket/API contracts.
