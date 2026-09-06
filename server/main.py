from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Before the routers import anything that reads os.environ at module scope.
from env import bootstrap

bootstrap()

from routes.breakdowns import router as breakdowns_router
from routes.runs import router as runs_router
from routes.scripts import router as scripts_router
from routes.sheets import router as sheets_router
from runtime_auth import announce, is_open, require_runtime_token

app = FastAPI(title="Dailies agent runtime")

announce()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3210"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Every router is gated. /health deliberately is not: a load balancer has to be
# able to reach it, and it exposes nothing but liveness and whether the token is
# configured.
_gated = [Depends(require_runtime_token)]
app.include_router(breakdowns_router, dependencies=_gated)
app.include_router(runs_router, dependencies=_gated)
app.include_router(scripts_router, dependencies=_gated)
app.include_router(sheets_router, dependencies=_gated)


@app.get("/health")
def health() -> dict[str, str]:
    # Reports whether the runtime is gated, so "did I remember the token?" is
    # answerable from outside rather than only from the startup log.
    return {"status": "ok", "auth": "open" if is_open() else "token"}
