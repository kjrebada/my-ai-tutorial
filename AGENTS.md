# Repository Instructions

## Architecture

- This repository contains two separate apps: the React/Vite frontend in `frontend/` and the Express API in `backend/`. Keep package dependencies, scripts, and lockfiles inside their respective app directories.
- **Code ownership:** The Expert React Frontend Engineer may change application code only in `frontend/`; the DevOps Expert may change application code only in `backend/`. Neither owner edits the other app's code, tests, configuration, or dependencies.
- If a change requires code owned by the other app, explain the need and ask that app's owner to implement it; coordinate cross-app decisions through Gilfoyle. Do not make the change yourself while waiting.
- Both owners may inspect either app and run either app's tests/builds to verify integration. Running verification does not transfer code ownership.
- **Primary-agent task routing:** Before implementing an application-code change, route the task to its owner instead of editing the app directly. Frontend-only implementation goes to **Expert React Frontend Engineer**; backend-only implementation goes to **DevOps Expert**. For cross-app changes, split the work into separate owner-scoped handoffs. The primary agent coordinates requirements and integration but does not bypass the owners.
- **Machine-readable handoffs:** Emit a standalone fenced `copilot-handoff` block for each owner task, containing exactly one JSON object. Use this shape, with `to` set to the exact receiving agent name:

  ```copilot-handoff
  {
    "protocol": "weather-portal.handoff.v1",
    "action": "handoff",
    "from": "Primary Agent",
    "to": "DevOps Expert",
    "summary": "Add hourly humidity to the weather API response.",
    "required_changes": ["Request Open-Meteo relative_humidity_2m", "Return it as humidityPercent per hourly entry"],
    "owned_paths": ["backend/server.js", "backend/server.test.js"],
    "acceptance_criteria": ["Humidity is null or a number from 0 to 100", "Backend tests cover normalization and invalid data"],
    "verification_commands": ["cd backend && npm test"]
  }
  ```

  The handoff is a request for the runner to invoke the named agent, not evidence that work has run. The runner should dispatch only blocks with the exact protocol and `action`, pass the JSON as the task, and return the receiving agent's result to the primary agent. The receiving agent must obey its ownership boundary. If no runner is available, show the block and state that dispatch did not occur; never claim it was executed.
- **Review-fix-verify-review workflow:** When a reviewer identifies frontend findings, hand them to Expert React Frontend Engineer; for backend findings, hand them to DevOps Expert. Include findings, owned paths, acceptance criteria, and the app's test/build command. The owner fixes only their scope and must run its available test/build scripts before returning results. After verification, hand the changed files and original findings back to the reviewer for an independent re-review. If re-review finds remaining issues, repeat with the appropriate owner; finish only after the reviewer confirms resolution or explicitly documents accepted residual findings. Never claim a reviewer handoff ran without a returned result.
- The browser uses `/api` routes to communicate with the backend. Vite proxies `/api` to `http://localhost:3001` during development.
- See [README.md](README.md) for setup steps and local development URLs. Follow the nearest nested `AGENTS.md` for frontend- or backend-specific details.
- For all accessibility topics, follow [a11y.instructions.md](.github/instructions/a11y.instructions.md).

## Runtime and Commands

- Use Node.js 20.19 or newer and npm.
- Start the backend with `cd backend && npm install && npm run dev`.
- Start the frontend separately with `cd frontend && npm install && npm run dev`.
- Build the frontend with `cd frontend && npm run build`.
- There are currently no test or lint scripts in either app; do not assume such commands are available.
