"""Render listing art from the current extension popup; requires Chrome and Pillow."""
from pathlib import Path
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store-assets"
HTML = (ROOT / "extension/popup.html").read_text()
CSS = (ROOT / "extension/popup.css").read_text()
ICON = ROOT / "extension/icons/icon128.png"

STAGE = """
<style>
body { width:1280px; height:800px; margin:0; background:#eaf3ed; font-family:Arial,sans-serif; }
.stage { width:1280px; height:800px; display:flex; align-items:center; justify-content:center; gap:100px; }
.copy { width:500px; } .copy small {font-size:19px;color:#0e7a43;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.copy h1 {font-size:58px;line-height:1.08;color:#173226;letter-spacing:-.04em;margin:24px 0}
.copy p {font-size:24px;line-height:1.35;color:#52685b;max-width:480px}
.popup-frame {width:350px; min-height:520px; background:#f8fbf9; box-shadow:0 24px 80px #17322630; border:1px solid #c9d9ce; border-radius:12px; overflow:hidden}
.popup-frame header {border-radius:12px 12px 0 0}
</style>
"""

def screenshot(name, heading, subtitle, mock):
    stage = f'<div class="stage"><div class="copy"><small>Yamlet Interceptor</small><h1>{heading}</h1><p>{subtitle}</p></div><div class="popup-frame">'
    mocked = f'<script>window.chrome={{storage:{{local:{{get:async()=>({mock})}}}},tabs:{{query:async()=>[{{url:"https://example.com/account",incognito:false}}]}}}};</script>'
    html = HTML.replace('<link rel="stylesheet" href="popup.css">', f'<style>{CSS}</style>{STAGE}')
    html = html.replace('<script defer src="popup.js"></script>', mocked + '<script defer src="file://' + str(ROOT / 'extension/popup.js') + '"></script>')
    html = html.replace('<img src="icons/icon48.png"', '<img src="file://' + str(ROOT / 'extension/icons/icon48.png') + '"')
    html = html.replace('<body>', '<body>' + stage).replace('</body>', '</div></div></body>')
    with tempfile.TemporaryDirectory() as temp:
        page = Path(temp) / "shot.html"
        page.write_text(html)
        subprocess.run(["google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", "--virtual-time-budget=1500", "--window-size=1280,800", f"--screenshot={OUT / name}", page.as_uri()], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    image = Image.open(OUT / name).convert("RGB")
    assert image.size == (1280, 800), image.size
    image.save(OUT / name)

screenshot("1-connect-1280x800.png", "Pair with local Yamlet", "Connect the extension to the workspace running on your computer.", "{}")
screenshot("2-approve-1280x800.png", "Approve one site", "Choose exactly which site's cookies Yamlet can use.", '{pairing:{base:"http://localhost:7878/",pairingId:"demo",secret:"demo"},sites:[]}')
screenshot("3-synced-1280x800.png", "Keep cookies current", "Approved sites refresh while Chrome and Yamlet are running.", '{pairing:{base:"http://localhost:7878/",pairingId:"demo",secret:"demo"},sites:["https://example.com"],lastSync:{site:"https://example.com",count:3,at:"2026-10-06T08:00:00.000Z"}}')

def font(size, bold=False):
    path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    return ImageFont.truetype(path, size)

for size, label in [((440, 280), "promo-small-440x280.png"), ((1400, 560), "promo-marquee-1400x560.png")]:
    im = Image.new("RGB", size, "#0e7a43")
    draw = ImageDraw.Draw(im)
    w, h = size
    icon_size = 112 if w == 440 else 184
    icon = Image.open(ICON).convert("RGBA").resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    im.paste(icon, (32 if w == 440 else 76, (h - icon_size) // 2), icon)
    x = 155 if w == 440 else 300
    draw.text((x, h // 2 - (50 if w == 440 else 90)), "Yamlet", fill="white", font=font(38 if w == 440 else 75, True))
    draw.text((x, h // 2 + (5 if w == 440 else 8)), "Interceptor", fill="white", font=font(23 if w == 440 else 48, True))
    if w > 440:
        draw.text((x, h // 2 + 82), "Browser cookies for your local workspace", fill="#d6f2e2", font=font(23))
    im.save(OUT / label)
