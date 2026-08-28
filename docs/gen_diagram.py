"""Generate docs/architecture-{light,dark}.svg for the README.

The claim made visual: two deterministic sources are tried before any model is
asked for a name, and the model only ever summarises label text it was handed.
Hand-tuned layout; run from the repo root after editing:
    python3 docs/gen_diagram.py
"""

import os

FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace"

THEMES = {
    "light": dict(text="#1f2328", muted="#59636e", border="#d0d7de", panel="#f6f8fa",
                  node="#ffffff", accent="#8250df", accent_soft="#fbf0ff",
                  red="#cf222e", green="#1a7f37", green_fill="#dafbe1",
                  green_border="#aceebb", edge="#8c959f"),
    "dark": dict(text="#e6edf3", muted="#9198a1", border="#3d444d", panel="#151b23",
                 node="#212830", accent="#ab7df8", accent_soft="#2a2139",
                 red="#f85149", green="#3fb950", green_fill="#122117",
                 green_border="#2b5233", edge="#767d86"),
}

W, H = 1000, 566


def build(c):
    s = []
    s.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="{FONT}" role="img" '
        'aria-label="Pharmonym architecture: a web widget posts to the convertDrugName Cloud Function, '
        'which returns straight from a Firestore cache on a hit and rejects requests over 30 per IP per '
        'hour. Name resolution is a cascade — RxNorm/RxNav first, openFDA as a deterministic fallback, and '
        'only if both miss is a model asked, with the result flagged. The resolved name is used to fetch '
        'the US openFDA label cited to DailyMed and the UK eMC SmPC; a grounded summary condenses only '
        'that fetched text before the response is cached and returned. The model never originates a '
        'clinical fact.">'
    )
    s.append(
        '<defs>'
        f'<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c["edge"]}"/></marker>'
        f'<marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c["green"]}"/></marker>'
        f'<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c["red"]}"/></marker>'
        '</defs>'
    )

    def txt(x, y, t, size=11, fill=None, weight=None, anchor="start", mono=False,
            style=None, rot=None):
        a = [f'x="{x}"', f'y="{y}"', f'font-size="{size}"', f'fill="{fill or c["text"]}"']
        if weight: a.append(f'font-weight="{weight}"')
        if anchor != "start": a.append(f'text-anchor="{anchor}"')
        if mono: a.append(f'font-family="{MONO}"')
        if style: a.append(f'font-style="{style}"')
        if rot: a.append(f'transform="rotate({rot} {x} {y})"')
        s.append(f'<text {" ".join(a)}>{t}</text>')

    def panel(x, y, w, h, title):
        s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" '
                 f'fill="{c["panel"]}" stroke="{c["border"]}"/>')
        txt(x + 18, y + 26, title, 11, c["muted"], "600")

    def node(cx, y, w, h, title, sub=None, fill=None, stroke=None, tcol=None,
             mono=False, dash=False):
        x = cx - w / 2
        extra = ' stroke-dasharray="5 4"' if dash else ""
        s.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" '
                 f'fill="{fill or c["node"]}" stroke="{stroke or c["border"]}"{extra}/>')
        if sub:
            txt(cx, y + 22, title, 13, tcol or c["text"], "600", "middle")
            txt(cx, y + 40, sub, 10.5 if mono else 11, c["muted"], anchor="middle", mono=mono)
        else:
            txt(cx, y + h / 2 + 4.5, title, 13, tcol or c["text"], "600", "middle")

    def line(pts, marker="a", col=None, dash=False):
        col = col or c["edge"]
        p = " ".join(f"{x},{y}" for x, y in pts)
        d = ' stroke-dasharray="5 4"' if dash else ""
        s.append(f'<polyline points="{p}" fill="none" stroke="{col}" stroke-width="1.5"{d} '
                 f'marker-end="url(#{marker})"/>')

    # ── request ───────────────────────────────────────────────────
    panel(16, 52, 200, 452, "REQUEST")
    ax = 116
    node(ax, 88, 168, 48, "Web widget", "pharmonym.html")
    line([(ax, 136), (ax, 174)])
    txt(ax + 8, 160, "POST", 10, c["muted"], mono=True)
    node(ax, 176, 168, 50, "convertDrugName", "Cloud Function")
    line([(ax, 226), (ax, 264)])
    node(ax, 266, 168, 52, "Cache check", "a hit returns here",
         fill=c["green_fill"], stroke=c["green_border"], tcol=c["green"])
    line([(ax, 318), (ax, 352)])
    txt(ax + 8, 342, "miss", 10, c["muted"])
    node(ax, 354, 168, 52, "Rate limit", "over 30 / IP / hour &#8594; 429")
    txt(34, 486, "no key, no account", 10.5, c["muted"], style="italic")

    # request -> resolution
    line([(ax, 406), (ax, 430), (226, 430), (226, 128), (275, 128)])

    # ── resolution cascade ────────────────────────────────────────
    panel(236, 52, 340, 452, "NAME RESOLUTION &#183; DETERMINISTIC FIRST")
    bx, BW = 412, 274
    tiers = [
        (100, "1 &#183; RxNorm / RxNav", "deterministic mapping", False),
        (192, "2 &#183; openFDA", "deterministic fallback", False),
        (284, "3 &#183; a model", "last resort &#8212; result flagged", True),
    ]
    for y, title, sub, is_ai in tiers:
        if is_ai:
            node(bx, y, BW, 54, title, sub, fill=c["accent_soft"],
                 stroke=c["accent"], tcol=c["accent"], dash=True)
        else:
            node(bx, y, BW, 54, title, sub,
                 stroke=c["green_border"], tcol=c["text"])
    for y in (154, 246):
        line([(bx, y), (bx, y + 36)])
        txt(bx + 10, y + 26, "no match", 10, c["muted"])
    txt(bx, 372, "Two deterministic sources are tried", 11.5, c["text"], "600", "middle")
    txt(bx, 390, "before any model is asked for a name.", 11.5, c["text"], "600", "middle")
    txt(bx, 414, "&#8212; and when one is, the answer is flagged", 10.5, c["accent"],
        anchor="middle", style="italic")

    # match rail out to the labels
    for y in (127, 219, 311):
        s.append(f'<line x1="549" y1="{y}" x2="562" y2="{y}" stroke="{c["green"]}" stroke-width="1.5"/>')
    s.append(f'<polyline points="562,311 562,114" fill="none" stroke="{c["green"]}" stroke-width="1.5"/>')
    line([(562, 114), (594, 114)], "ag", c["green"])
    txt(556, 230, "resolved name", 10, c["green"], "600", anchor="middle", rot=-90)

    # ── labels + summary ──────────────────────────────────────────
    panel(596, 52, 388, 452, "OFFICIAL LABELS &#183; THEN THE SUMMARY")
    cx = 790
    node(cx, 92, 336, 44, "getLabels()")
    line([(cx, 136), (cx, 152)])
    node(cx, 154, 336, 46, "US label &#8212; openFDA", "cited to DailyMed",
         stroke=c["green_border"])
    line([(cx, 200), (cx, 214)])
    node(cx, 216, 336, 46, "UK label &#8212; eMC SmPC", "Summary of Product Characteristics",
         stroke=c["green_border"])
    line([(cx, 262), (cx, 282)])
    node(cx, 284, 336, 56, "Grounded summary", "condenses only the text above",
         fill=c["accent_soft"], stroke=c["accent"], tcol=c["accent"])
    line([(cx, 340), (cx, 358)])
    node(cx, 360, 336, 46, "Cache write", "Firestore &#183; 30d / 1d TTL",
         fill=c["green_fill"], stroke=c["green_border"], tcol=c["green"])
    line([(cx, 406), (cx, 424)], "ag", c["green"])
    node(cx, 426, 336, 44, "JSON response", None,
         fill=c["green_fill"], stroke=c["green_border"], tcol=c["green"])

    # ── the claim ─────────────────────────────────────────────────
    txt(500, 536, "A model is asked twice &#8212; as a flagged last resort for a name, and to summarise "
        "label text it was handed.", 12, c["text"], "600", "middle")
    txt(500, 555, "It never originates a clinical fact.", 12, c["accent"], "700", "middle")

    s.append("</svg>")
    return "\n".join(s)


os.makedirs("docs", exist_ok=True)
for name, pal in THEMES.items():
    p = f"docs/architecture-{name}.svg"
    open(p, "w", encoding="utf-8").write(build(pal))
    print("wrote", p)
