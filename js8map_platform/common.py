"""Rules shared by the Windows and Linux window code. Standard library only."""

SPOTTER_MAP_TITLE = "JS8Map Spotter"


def is_spotter_map_title(title: str) -> bool:
    """True only for the Spotter map page's own title.

    app.js sets it to "<CALL> \u00b7 JS8Map Spotter" ("JS8Map Spotter" before
    boot). It used to be a CONTAINS test, and Generate Map raised the WRONG
    window (17f, operator, Windows 2026-10-17): the Claude desktop app's
    title held a chat named "JS8Map Spotter Linux Testing", so Claude came
    forward and no map opened. Titles ending in "JS8Map" (JS8Map 1.75's own
    map window -- a separate program since 1.2) must not match either.
    """
    t = (title or "").strip()
    return t == SPOTTER_MAP_TITLE or t.endswith(" \u00b7 " + SPOTTER_MAP_TITLE)
