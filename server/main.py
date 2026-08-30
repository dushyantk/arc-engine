from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Before the routers import anything that reads os.environ at module scope.
from env import bootstrap

bootstrap()

from routes.runs import router as runs_router

app = FastAPI(title="Dailies agent runtime")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3210"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(runs_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
