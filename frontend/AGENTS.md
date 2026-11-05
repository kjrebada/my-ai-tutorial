# Frontend Instructions

- **Ownership boundary:** The frontend owner may change application code, tests, configuration, and dependencies only in `frontend/`; do not edit anything under `backend/`. If frontend work requires a backend change, ask the DevOps Expert to implement it and coordinate the API contract with Gilfoyle. You may inspect backend code and run backend tests for integration verification.
- For a backend/API dependency, emit the shared `copilot-handoff` JSON block addressed to `DevOps Expert`; include the exact contract changes, backend-owned paths, acceptance criteria, and backend verification command. Do this as soon as the dependency is known so the automation runner can dispatch it without waiting for user approval. Continue only with frontend-owned work and do not claim backend work is complete until the handoff result is returned.
- This app uses React 19, JavaScript/JSX ES modules, and Vite. Its dependencies and scripts are declared in `package.json`; use the frontend lockfile when installing dependencies.
- `src/main.jsx` mounts the app, `src/App.jsx` contains the current page and API status flow, and `src/style.css` contains its global styles.
- Call backend endpoints through relative `/api/...` URLs. The Vite proxy in `vite.config.mjs` forwards `/api` to `http://localhost:3001`; do not hardcode a separate browser API origin for local development.
- Keep loading, successful, and failed API request states distinguishable, and show request failures in the UI.

## Commands

- Install dependencies: `npm install` (from `frontend/`).
- Start the development server: `npm run dev` (from `frontend/`).
- Create a production build: `npm run build` (from `frontend/`).
- There are currently no frontend test or lint scripts.
