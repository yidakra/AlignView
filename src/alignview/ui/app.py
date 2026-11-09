"""Dash application factory and dev-server entrypoint for the AlignView UI.

``build_app`` assembles the layout, mirror, and engine and registers callbacks,
defaulting to the offline :class:`~alignview.ui.chat.PlaceholderEngine` so the
dashboard runs with no models, Qdrant, or vLLM.  A future ``RagEngine`` is
injected via the ``engine`` argument without touching the layout or callbacks.

The whole layout is wrapped in a :class:`dmc.MantineProvider`; every visual
surface is a Dash Mantine Component themed from :data:`THEME` (Dash Mantine
Components ships its CSS in its JS bundle, so no external stylesheet is needed).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from alignview.ui.callbacks import register_callbacks
from alignview.ui.chat import ChatEngine
from alignview.ui.layout import build_layout
from alignview.ui.study_log import StudyLog
from alignview.ui.youtube import YouTubeMirror

if TYPE_CHECKING:
    from dash import Dash

# Single source of truth for the Mantine theme (indigo accent, soft radius),
# matching the dashboard's original light/indigo look.
THEME = {
    "primaryColor": "indigo",
    "primaryShade": 6,
    "defaultRadius": "md",
    "fontFamily": "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
    "fontFamilyMonospace": "ui-monospace, SFMono-Regular, Menlo, monospace",
}


def build_app(
    engine: Optional[ChatEngine] = None,
    mirror: Optional[YouTubeMirror] = None,
    cfg: Optional[object] = None,
    require_live: bool = False,
) -> "Dash":
    """Build and return the configured Dash app (callbacks registered).

    With ``require_live=True`` the real RagEngine is required: if the backend
    cannot be built, ``build_engine`` raises ``EngineUnavailable`` instead of
    silently falling back to the offline demo engine.
    """
    import dash_mantine_components as dmc
    from dash import Dash

    from alignview.ui.engine_factory import build_engine, engine_mode

    mirror = mirror or YouTubeMirror.from_csv()
    engine = engine or build_engine(mirror, cfg=cfg, require_live=require_live)

    # Read score_mode from engine config when live, else load it from base.yaml so
    # offline mode still honours whatever is set in the config file.
    import os

    from alignview.config import load_config
    cfg = getattr(engine, "cfg", None) or cfg or load_config(
        override_path=os.getenv("ALIGNVIEW_CONFIG")
    )
    score_mode: str = getattr(getattr(cfg, "ui", None), "score_mode", "rrf_normalized")

    # Opt-in user-study interaction log (ALIGNVIEW_STUDY_LOG); off by default.
    study_log = StudyLog.from_env()

    app = Dash(__name__, title="AlignView")
    app.layout = dmc.MantineProvider(
        build_layout(
            mirror,
            mode=engine_mode(engine),
            score_mode=score_mode,
            cfg=cfg,
            study=study_log.enabled,
        ),
        theme=THEME,
        forceColorScheme="light",
    )
    register_callbacks(app, engine, mirror, study_log=study_log)
    _install_basic_auth(app)
    return app


def _install_basic_auth(app: "Dash") -> None:
    """Gate the whole dashboard behind HTTP Basic Auth when configured.

    Reads ``ALIGNVIEW_UI_BASIC_AUTH="user:password"``. Intended for public
    exposure (e.g. a cloudflared tunnel for a demo) so the live GPU backend
    isn't open to anyone with the link. Unset by default, so local and
    SSH-tunnel use is unchanged. Stdlib only — no extra dependency, works on the
    offline compute nodes the live UI runs on.
    """
    import hmac
    import os

    cred = os.getenv("ALIGNVIEW_UI_BASIC_AUTH", "").strip()
    if not cred:
        return
    if ":" not in cred:
        raise ValueError(
            "ALIGNVIEW_UI_BASIC_AUTH must be formatted as user:password"
        )
    user, _, password = cred.partition(":")
    if not user or not password:
        raise ValueError(
            "ALIGNVIEW_UI_BASIC_AUTH requires non-empty user and password"
        )

    from flask import Response, request

    @app.server.before_request  # type: ignore[union-attr]
    def _require_basic_auth():
        auth = request.authorization
        if (
            auth is not None
            and hmac.compare_digest(auth.username or "", user)
            and hmac.compare_digest(auth.password or "", password)
        ):
            return None
        return Response(
            "Authentication required.",
            401,
            {"WWW-Authenticate": 'Basic realm="AlignView demo"'},
        )


def run(
    host: str = "127.0.0.1",
    port: int = 8050,
    debug: bool = False,
    cfg: Optional[object] = None,
    require_live: bool = False,
) -> None:
    """Launch the Dash development server."""
    build_app(cfg=cfg, require_live=require_live).run(
        host=host, port=port, debug=debug
    )


if __name__ == "__main__":
    run(debug=True)
