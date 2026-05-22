from contextlib import asynccontextmanager
import os
import sys
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.app.routers import analytics, auth, calibration, caller, club, custom_games, detection, games, gif_reactions, health, models, sound_fx, tournaments, training, wled
from backend.core.capabilities import diagnostics_context
from backend.core.caller import get_caller_service
from backend.core import wled as wled_core
from backend.core.custom_games_store import custom_games_root
from backend.core.owner_analytics import get_owner_analytics_service
from backend.core.sound_fx import get_sound_fx_service

_CAMERA_START_REQUESTED = threading.Event()


def _is_packaged_runtime() -> bool:
    exe_name = Path(sys.executable).name.lower()
    return bool(
        getattr(sys, "frozen", False)
        or "__compiled__" in globals()
        or exe_name in {"darts-backend.exe", "darts-backend"}
    )


def _start_camera_service_async() -> None:
    if _CAMERA_START_REQUESTED.is_set():
        return
    _CAMERA_START_REQUESTED.set()

    def _run() -> None:
        try:
            calibration.camera_service.start()
        except Exception as exc:
            print(f"[camera] async startup failed: {exc}")

    threading.Thread(target=_run, name="camera-service-startup", daemon=True).start()


@asynccontextmanager
async def lifespan(_: FastAPI):
    diag = diagnostics_context()
    print(
        "[diag] startup context:",
        f"edition={diag.get('edition')}",
        f"role={diag.get('role')}",
        f"venue={diag.get('venue_id')}",
        f"board={diag.get('board_id')}",
    )
    _start_camera_service_async()
    calibration.start_startup_auto_calibration()
    get_caller_service()
    get_sound_fx_service()
    get_owner_analytics_service().start()
    wled_core.apply_idle_async(min_interval_ms=0)
    try:
        yield
    finally:
        get_owner_analytics_service().shutdown()
        calibration.camera_service.close()


def _control_frontend_build_dir() -> Path | None:
    env_path = os.getenv("MACHINE_DARTS_CONTROL_FRONTEND_DIR", "").strip()
    candidates: list[Path] = []
    if env_path:
        candidates.append(Path(env_path).expanduser().resolve())

    def _is_frontend_dir(path: Path) -> bool:
        try:
            return (
                path.exists()
                and (path / "index.html").exists()
                and (path / "assets").exists()
            )
        except Exception:
            return False

    packaged_runtime = _is_packaged_runtime()
    if packaged_runtime:
        exe_dir = Path(sys.executable).resolve().parent
        bases = [exe_dir]
        for i in range(1, 6):
            try:
                bases.append(exe_dir.parents[i - 1])
            except Exception:
                break
        for base in bases:
            candidates.append(base / "dist")
            candidates.append(base / "resources" / "dist")
            candidates.append(base / "frontend")
            candidates.append(base / "frontend" / "dist")
            candidates.append(base / "resources" / "frontend")
            candidates.append(base / "resources" / "frontend" / "dist")
            candidates.append(base / "_up_" / "_up_" / "frontend")
            candidates.append(base / "_up_" / "_up_" / "frontend" / "dist")
            candidates.append(base / "_up_" / "_up_" / "dist")
    else:
        project_root = Path(__file__).resolve().parents[2]
        candidates.append(project_root / "frontend" / "dist")

    for candidate in candidates:
        if _is_frontend_dir(candidate):
            return candidate

    if packaged_runtime:
        # Last-resort for installer layouts that preserve a different resource
        # folder shape. Keep the search close to the exe so startup stays quick.
        seen: set[str] = set()

        def _walk_frontend_candidates(root: Path, max_depth: int = 4):
            stack: list[tuple[Path, int]] = [(root, 0)]
            while stack:
                current, depth = stack.pop()
                if _is_frontend_dir(current):
                    yield current
                    return
                if depth >= max_depth:
                    continue
                try:
                    children = list(current.iterdir())
                except Exception:
                    continue
                for child in children:
                    try:
                        if child.is_dir():
                            stack.append((child, depth + 1))
                    except Exception:
                        continue

        for base in bases:
            key = str(base).lower()
            if key in seen or not base.exists():
                continue
            seen.add(key)
            for candidate in _walk_frontend_candidates(base):
                return candidate
    return None


def create_app() -> FastAPI:
    app = FastAPI(
        title="Machine Darts API",
        version="0.1.0",
        description="Slim backend for camera streaming, calibration, and detection.",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def no_cache_frontend_shell(request, call_next):
        response = await call_next(request)
        path = request.url.path
        content_type = response.headers.get("content-type", "")
        if path in {"/", "/play"} or path.endswith(".html") or "text/html" in content_type:
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    app.include_router(health.router)
    app.include_router(analytics.router)
    app.include_router(auth.router)
    app.include_router(calibration.router)
    app.include_router(caller.router)
    app.include_router(club.router)
    app.include_router(custom_games.router)
    app.include_router(detection.router)
    app.include_router(games.router)
    app.include_router(gif_reactions.router)
    app.include_router(models.router)
    app.include_router(sound_fx.router)
    app.include_router(tournaments.router)
    app.include_router(training.router)
    app.include_router(wled.router)

    control_frontend_dir = _control_frontend_build_dir()
    custom_games_content_dir = custom_games_root() / "packages"
    custom_games_content_dir.mkdir(parents=True, exist_ok=True)
    app.mount(
        "/custom-games-content",
        StaticFiles(directory=str(custom_games_content_dir), html=True),
        name="custom-games-content",
    )

    if control_frontend_dir is not None:
        print(f"[frontend] serving control UI from {control_frontend_dir}")
        app.mount("/play", StaticFiles(directory=str(control_frontend_dir), html=True), name="play")
        app.mount("/", StaticFiles(directory=str(control_frontend_dir), html=True), name="control")
    else:
        print("[frontend] control UI build not found; backend API only")
    return app


app = create_app()
