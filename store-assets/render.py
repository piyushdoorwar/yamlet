"""Render Web Store images from the current popup with its bundled DM Sans font."""

import base64
import subprocess
import tempfile
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
OUT = ROOT / "store-assets"
POPUP_HTML = (EXT / "popup.html").read_text()
POPUP_CSS = (EXT / "popup.css").read_text()
POPUP_JS = (EXT / "popup.js").read_text()
CONFIRM_HTML = (EXT / "confirm.html").read_text()
CONFIRM_JS = (EXT / "confirm.js").read_text()
MARK = (EXT / "icons/icon.svg").read_text()


def data_url(path: Path, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def bundled_fonts(css: str) -> str:
    for font in (EXT / "fonts").glob("*.woff2"):
        css = css.replace(f'url("fonts/{font.name}")', f'url("{data_url(font, "font/woff2")}")')
    return css


FONT_CSS = bundled_fonts(POPUP_CSS)


def capture(html: str, target: Path, width: int, height: int, scale: int = 1) -> None:
    with tempfile.TemporaryDirectory() as temporary:
        page = Path(temporary) / "image.html"
        page.write_text(html)
        raw = Path(temporary) / "capture.png"
        subprocess.run(
            ["google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
             "--hide-scrollbars", "--virtual-time-budget=1500", f"--window-size={width * scale},{height * scale}",
             f"--screenshot={raw}", page.as_uri()],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        image = Image.open(raw).convert("RGB")
        assert image.size == (width * scale, height * scale), image.size
        if scale != 1:
            image = image.resize((width, height), Image.Resampling.LANCZOS)
        image.save(target, optimize=True)


STAGE_CSS = """
<style>
body { width:1280px; height:800px; margin:0; background:#fcfcfc; font-family:var(--font-sans); }
.stage { box-sizing:border-box; width:1280px; height:800px; display:flex; align-items:center; justify-content:center; gap:80px;
  border-top:8px solid #0e7a43; background-image:linear-gradient(#e9eeeb 1px,transparent 1px),linear-gradient(90deg,#e9eeeb 1px,transparent 1px); background-size:40px 40px; }
.copy { width:540px; background:#fcfcfcef; padding:18px 0; }
.copy small { font-size:17px; color:#0e7a43; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
.copy h1 { font-size:54px; line-height:1.08; color:#0f1a14; letter-spacing:-.035em; margin:20px 0; }
.copy p { font-size:23px; line-height:1.38; color:#4b5a52; max-width:510px; margin:0; }
.popup-frame { box-sizing:border-box; width:360px; min-height:500px; background:#fff; box-shadow:0 24px 70px #0f1a1426;
  border:1px solid #dce3de; border-radius:12px; overflow:hidden; }
.window-frame { box-sizing:border-box; width:400px; background:#fff; box-shadow:0 24px 70px #0f1a1426;
  border:1px solid #dce3de; border-radius:10px; overflow:hidden; }
.window-bar { height:34px; display:flex; align-items:center; padding:0 12px; background:#f1f4f2; border-bottom:1px solid #dce3de;
  font-size:12px; color:#4b5a52; }
.window-frame body, .window-frame > div { min-height:0; }
</style>
"""


def stage(heading: str, subtitle: str) -> str:
    return f'<div class="stage"><div class="copy"><small>Yamlet Interceptor</small><h1>{heading}</h1><p>{subtitle}</p></div>'


def confirm_screenshot(filename: str, heading: str, subtitle: str, base: str) -> None:
    """The window the extension opens when a Yamlet page asks to pair."""
    mock = ('<script>window.chrome={'
            f'storage:{{session:{{get:async()=>({{pendingPagePair:{{base:"{base}"}}}})}}}},'
            'runtime:{sendMessage:async()=>({ok:true})}'
            '};</script>')
    page = CONFIRM_HTML.replace('<link rel="stylesheet" href="popup.css">', f"<style>{FONT_CSS}</style>{STAGE_CSS}")
    page = page.replace('<script defer src="confirm.js"></script>', mock)
    page = page.replace(
        '<body class="confirm">',
        f'<body class="confirm">{stage(heading, subtitle)}<div class="window-frame"><div class="window-bar">Connect to Yamlet</div>',
    ).replace("</body>", f"<script>{CONFIRM_JS}</script></div></div></body>")
    capture(page, OUT / filename, 1280, 800)


def screenshot(filename: str, heading: str, subtitle: str, state: str) -> None:
    mock = ('<script>window.chrome={'
            f'storage:{{local:{{get:async()=>({state})}},onChanged:{{addListener:()=>{{}}}}}},'
            'tabs:{query:async()=>[{url:"https://example.com/account",incognito:false}]}'
            '};</script>')
    page = POPUP_HTML.replace('<link rel="stylesheet" href="popup.css">', f"<style>{FONT_CSS}</style>{STAGE_CSS}")
    page = page.replace('<script defer src="popup.js"></script>', mock)
    page = page.replace(
        "<body>",
        f'<body>{stage(heading, subtitle)}<div class="popup-frame">',
    ).replace("</body>", f"<script>{POPUP_JS}</script></div></div></body>")
    capture(page, OUT / filename, 1280, 800)


for size in (16, 32, 48, 128):
    cairosvg.svg2png(bytestring=MARK.encode(), write_to=str(EXT / f"icons/icon{size}.png"), output_width=size, output_height=size)

confirm_screenshot("1-connect-1280x800.png", "Pair in one click", "Choose Pair extension in Yamlet, then confirm the address in this window. No code to copy.", "http://localhost:7878/")
screenshot("2-approve-1280x800.png", "Approve one site", "Choose exactly which site's cookies Yamlet can use.", '{pairing:{base:"http://localhost:7878/",pairingId:"demo",secret:"demo"},sites:[]}')
screenshot("3-synced-1280x800.png", "Keep cookies current", "Approved sites refresh while Chrome and Yamlet are running.", '{pairing:{base:"http://localhost:7878/",pairingId:"demo",secret:"demo"},sites:["https://example.com"],lastSync:{site:"https://example.com",count:3,at:"2026-10-06T08:00:00.000Z"}}')


def promo(width: int, height: int, filename: str, scale: int = 1) -> None:
    word_size = 43 if width == 440 else 94
    subtitle_size = 18 if width == 440 else 35
    icon_size = 112 if width == 440 else 212
    left = 25 if width == 440 else 95
    text_left = 150 if width == 440 else 335
    detail = "Browser cookies for Yamlet" if width == 440 else "Browser cookies for your local workspace"
    medium = data_url(EXT / "fonts/dm-sans-latin-500-normal.woff2", "font/woff2")
    bold = data_url(EXT / "fonts/dm-sans-latin-700-normal.woff2", "font/woff2")
    logo = data_url(EXT / "icons/icon128.png", "image/png")
    page = f"""<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face {{ font-family:'DM Sans'; font-weight:500; src:url('{medium}') format('woff2'); }}
    @font-face {{ font-family:'DM Sans'; font-weight:700; src:url('{bold}') format('woff2'); }}
    * {{ box-sizing:border-box }} body {{ margin:0; width:{width*scale}px; height:{height*scale}px; background:#fcfcfc; font-family:'DM Sans',sans-serif; }}
    .canvas {{ width:{width}px;height:{height}px;transform:scale({scale});transform-origin:top left;position:relative;overflow:hidden;
      background:linear-gradient(90deg,#fcfcfc 60%,#eef7f1);border-top:7px solid #0e7a43; }}
    .mark {{ position:absolute;left:{left}px;top:{(height-icon_size)//2}px;width:{icon_size}px;height:{icon_size}px }}
    .copy {{ position:absolute;left:{text_left}px;top:{height//2 - (53 if width == 440 else 105)}px;white-space:nowrap; }}
    .name {{ color:#0f1a14;font-size:{word_size}px;font-weight:700;letter-spacing:-.04em;line-height:1.1 }}
    .label {{ color:#0e7a43;font-size:{subtitle_size+3}px;font-weight:700;line-height:1.25 }}
    .detail {{ color:#4b5a52;font-size:{subtitle_size}px;font-weight:500;margin-top:{10 if width == 440 else 20}px }}
    </style></head><body><div class="canvas"><img class="mark" src="{logo}" alt=""><div class="copy"><div class="name">Yamlet</div><div class="label">Interceptor</div><div class="detail">{detail}</div></div></div></body></html>"""
    capture(page, OUT / filename, width, height, scale)


promo(440, 280, "promo-small-440x280.png", scale=2)
promo(1400, 560, "promo-marquee-1400x560.png")
