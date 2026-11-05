# Backend Instructions

- **Ownership boundary:** The backend owner may change application code, tests, configuration, and dependencies only in `backend/`; do not edit anything under `frontend/`. If backend work requires a frontend change, ask the Expert React Frontend Engineer to implement it and coordinate cross-app decisions with Gilfoyle. You may inspect frontend code and run frontend tests/builds for integration verification.
- This app uses Express 5 and JavaScript CommonJS (`require`). Keep backend dependencies, scripts, and lockfile in `backend/`.
- Define API routes under `/api` so they match the frontend's Vite proxy and keep the service boundary consistent.
- The server listens on `Number(process.env.PORT)` when configured, otherwise port `3001`. Preserve this default when changing startup behavior.
- `GET /api/health` is the current example route and returns JSON consumed by the frontend.

## Commands

- Install dependencies: `npm install` (from `backend/`).
- Start the development server: `npm run dev` (from `backend/`).
- Start the server: `npm start` (from `backend/`).
- There are currently no backend test or lint scripts.
