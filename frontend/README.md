## Frontend (Slim V1)

Only the core pages are included in V1:

- `src/pages/HomePage.tsx`
- `src/pages/CalibrationPage.tsx`

Service boundaries:

- `src/services/api.ts`: HTTP calls
- `src/services/ws.ts`: websocket clients

This keeps UI code easy to find while we migrate selected pieces from the old app.

## Run

```bash
cd frontend
npm install
npm run dev
```

Open:

- `http://localhost:5173/#/` (Home)
- `http://localhost:5173/#/calibration` (Calibration)
