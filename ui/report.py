"""
Network Report
==============
Self-contained HTML report: interactive map, settings, gateway and node
tables, and per-link budget + interactive terrain profile.

Opens in any browser; "Print → Save as PDF" gives a PDF. Map tiles and
Plotly load from the internet when the file is opened.
"""

import html


def _esc(v) -> str:
    return html.escape(str(v), quote=True)


def _table(headers: list, rows: list) -> str:
    head = "".join(f"<th>{_esc(h)}</th>" for h in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{_esc(c)}</td>" for c in row) + "</tr>" for row in rows
    )
    return f'<div class="tbl"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _frame(doc: str, height: int, cls: str = "") -> str:
    return (f'<iframe class="{cls}" srcdoc="{_esc(doc)}" style="height:{height}px" '
            f'loading="lazy"></iframe>')


GLOSSARY = [
    ("Propagation model", "How path loss over the terrain is estimated. Longley-Rice (ITM) "
     "uses the real elevation profile: ground reflection and diffraction over every ridge. "
     "Links under ~1 km, where ITM does not apply, use a short-path model (ITU-R P.526): "
     "diffraction over rounded hills plus ground reflection."),
    ("Terrain loss", "Extra loss over free space caused by the terrain along the path."),
    ("Clutter loss", "Loss from what surrounds the sensor: crops, orchards, buildings."),
    ("Safety margin", "How many dB above the gateway's minimum (sensitivity) the signal must "
     "arrive to call a link viable: the reserve for rain, wet or moving foliage and other "
     "day-to-day variation."),
    ("Link margin", "dB left over the safety margin. Viable when it is zero or more."),
    ("Spreading factor (SF)", "LoRa data rate. Higher SF = more range, slower and longer "
     "airtime. US915 uplinks allow SF7–SF10."),
    ("Fresnel clearance", "How much of the zone around the line of sight is free of terrain. "
     "Below 60% the signal starts losing power; negative means the line of sight is blocked."),
    ("Device models", "Gateway and node values come from the manufacturers' datasheets. "
     "Where a value is not published (mostly antenna gains) a typical figure is used; "
     "these are refined with real RSSI readings from the network."),
    ("Cellular nodes", "4G sensors (NB-IoT / LTE-M) send data over the cell network, not "
     "through a LoRaWAN gateway. They are checked against the 4G coverage the operator "
     "declares to the regulator (outdoor LTE); LTE-M / NB-IoT usually reach as far or farther."),
    ("Guaranteed / differentiated coverage", "Guaranteed: the operator commits to service quality "
     "there. Differentiated: there is signal but without that commitment (weaker or variable). "
     "'Uncertain' means covered, but close to an area without signal. How close depends on the "
     "terrain: where a hill cuts the signal the edge is sharp (40 m margin); on flat ground the "
     "edge is set by distance to the tower and a few dB of error move it a long way (up to 300 m)."),
    ("Continuous coverage / farthest signal", "Along the gateway→node direction: distance "
     "before the first point without signal, and the last point that still has signal."),
]


def build_report_html(
    title: str,
    generated_at: str,
    map_html: str,
    settings: list,
    gateway_rows: list,
    node_rows: list,
    links: list,
    description: str = "",
) -> str:
    """
    links: list of dicts with keys name, status, viable, budget_rows, profile_html, range_text.
    """
    link_sections = []
    for ln in links:
        badge = "ok" if ln["viable"] else "fail"
        link_sections.append(f"""
<section class="link">
  <h3>{_esc(ln["name"])} <span class="badge {badge}">{_esc(ln["status"])}</span></h3>
  <div class="link-grid">
    <div>{_table(["Item", "Value"], ln["budget_rows"])}
      {f'<p class="note">{_esc(ln["range_text"])}</p>' if ln.get("range_text") else ""}
    </div>
    <div>{_frame(ln["profile_html"], 430, "chart") if ln.get("profile_html") else
          '<p class="note">No terrain profile available.</p>'}</div>
  </div>
</section>""")

    glossary = "".join(f"<dt>{_esc(t)}</dt><dd>{_esc(d)}</dd>" for t, d in GLOSSARY)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(title)}</title>
<style>
  :root {{ --ink:#1d2329; --muted:#5f6b76; --line:#dde2e7; --ok:#0b8a5f; --fail:#c0392b; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; padding:24px 20px 48px; font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         color:var(--ink); background:#fff; max-width:1200px; margin-inline:auto; }}
  h1 {{ margin:0 0 4px; font-size:24px; }}
  h2 {{ margin:32px 0 10px; font-size:18px; border-bottom:1px solid var(--line); padding-bottom:6px; }}
  h3 {{ margin:0 0 10px; font-size:16px; }}
  .meta {{ color:var(--muted); margin:0 0 16px; }}
  .desc {{ margin:4px 0 8px; white-space:pre-line; }}
  iframe {{ width:100%; border:1px solid var(--line); border-radius:6px; }}
  .tbl {{ overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; font-size:13px; }}
  th, td {{ text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }}
  th {{ color:var(--muted); font-weight:600; }}
  .link {{ border:1px solid var(--line); border-radius:8px; padding:14px; margin:14px 0; break-inside:avoid; }}
  .link-grid {{ display:grid; grid-template-columns:minmax(260px,1fr) 2fr; gap:16px; }}
  @media (max-width: 800px) {{ .link-grid {{ grid-template-columns:1fr; }} }}
  .badge {{ font-size:12px; padding:2px 8px; border-radius:10px; color:#fff; vertical-align:middle; }}
  .badge.ok {{ background:var(--ok); }} .badge.fail {{ background:var(--fail); }}
  .note {{ color:var(--muted); font-size:12px; }}
  dt {{ font-weight:600; margin-top:8px; }} dd {{ margin:0 0 0 0; color:var(--muted); }}
  @media print {{ body {{ padding:0; }} .link {{ page-break-inside:avoid; }} }}
</style>
</head>
<body>
  <h1>{_esc(title)}</h1>
  {f'<p class="desc">{_esc(description)}</p>' if description else ""}
  <p class="meta">Generated {_esc(generated_at)} with Verea</p>

  <h2>Map</h2>
  {_frame(map_html, 560, "map")}
  <p class="note">Hover a terrain profile below to locate the point on this map; click to pin it.</p>

  <h2>Settings</h2>
  {_table(["Setting", "Value"], settings)}

  <h2>Gateways</h2>
  {_table(["Name", "Model", "Status", "Latitude", "Longitude", "Height AGL (m)", "Gain (dBi)",
           "Cable loss (dB)", "TX (dBm)"], gateway_rows)}

  <h2>Nodes</h2>
  {_table(["Name", "Model", "Latitude", "Longitude", "Height AGL (m)", "TX (dBm)", "Gain (dBi)",
           "SF", "Environment", "Gateway", "Distance (km)", "RX (dBm)", "Margin (dB)", "Status"], node_rows)}

  <h2>Links</h2>
  {"".join(link_sections) or '<p class="note">No links calculated.</p>'}

  <h2>Glossary</h2>
  <dl>{glossary}</dl>
</body>
</html>"""
