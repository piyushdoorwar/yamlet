"""Render social-card.svg with the app's local DM Sans and JetBrains Mono fonts."""

import base64
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / "site/assets/social-card.svg"
PNG = ROOT / "site/assets/social-card.png"
FONTS = ROOT / "node_modules/@fontsource"


def font_face(family: str, package: str, weight: int) -> str:
    font = FONTS / package / "files" / f"{package}-latin-{weight}-normal.woff2"
    data = base64.b64encode(font.read_bytes()).decode("ascii")
    return (
        f'@font-face {{ font-family: "{family}"; font-style: normal; '
        f'font-weight: {weight}; src: url("data:font/woff2;base64,{data}") format("woff2"); }}'
    )


styles = "".join(
    [
        *(font_face("DM Sans", "dm-sans", weight) for weight in (400, 500, 600, 700)),
        *(font_face("JetBrains Mono", "jetbrains-mono", weight) for weight in (400, 700)),
    ]
)
html = (
    '<!doctype html><meta charset="utf-8"><style>'
    f"{styles}html,body{{margin:0;width:1200px;height:630px;overflow:hidden}}svg{{display:block}}"
    f"</style>{SVG.read_text()}"
)

with tempfile.TemporaryDirectory() as directory:
    page = Path(directory) / "social-card.html"
    raw = Path(directory) / "social-card.png"
    page.write_text(html)
    subprocess.run(
        [
            "google-chrome", "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
            "--virtual-time-budget=1500", "--window-size=1200,630", f"--screenshot={raw}", page.as_uri(),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with Image.open(raw) as image:
        assert image.size == (1200, 630), image.size
        image.convert("RGB").save(PNG, optimize=True)
