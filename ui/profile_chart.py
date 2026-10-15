"""
Terrain Profile Visualization
==============================
Matplotlib-based terrain profile chart with:
- GATEWAY label (blue, left/pos0) and NODE label (green, right/pos-1)
- Vertical lines from ground to antenna height
- Y-axis zoomed to relevant elevation range
- Legend as text inside axes (ax.text, survives Streamlit rendering)
- Min clearance annotation
- Elevation summary helper function
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.figure import Figure

from core.terrain import TerrainProfile


def plot_terrain_profile(
    terrain: TerrainProfile,
    h_tx_asl: float,
    h_rx_asl: float,
    freq_hz: float,
    los_analysis: dict,
    title: str = "Terrain Profile — LOS & Fresnel Analysis",
    figsize: tuple = (12, 5),
) -> Figure:
    """
    Generate terrain profile plot.

    Convention:
    - Position 0 (left) = GATEWAY (h_tx_asl)
    - Position -1 (right) = NODE (h_rx_asl)
    """
    d_km = terrain.distances / 1000
    elevations = terrain.elevations
    eff_terrain = los_analysis["effective_terrain"]
    los_line = los_analysis["los_heights"]
    fresnel_r = los_analysis["fresnel_radii"]
    clearance = los_analysis["clearance_m"]

    # ── Y-axis range: zoom to relevant elevation ──
    all_heights = np.concatenate([
        elevations, eff_terrain, los_line,
        los_line + fresnel_r, los_line - fresnel_r,
        [h_tx_asl, h_rx_asl],
    ])
    y_min = float(np.min(all_heights))
    y_max = float(np.max(all_heights))
    y_pad = max((y_max - y_min) * 0.15, 5.0)

    fig, ax = plt.subplots(figsize=figsize, facecolor="#0e1117")
    ax.set_facecolor("#0e1117")

    # ── Terrain fill ──
    ax.fill_between(
        d_km, elevations, y_min - y_pad, alpha=0.5,
        color="#2d6a4f", zorder=2,
    )
    ax.plot(d_km, elevations, color="#40916c", linewidth=1.2, zorder=3)

    # ── Effective terrain (with earth curvature) ──
    ax.plot(
        d_km, eff_terrain, color="#95d5b2", linewidth=0.8,
        linestyle="--", alpha=0.7, zorder=3,
    )

    # ── LOS line ──
    ax.plot(
        d_km, los_line, color="#e0e0e0", linewidth=1.5,
        linestyle="-", zorder=5,
    )

    # ── Fresnel zone envelope ──
    fresnel_upper = los_line + fresnel_r
    fresnel_lower = los_line - fresnel_r
    ax.fill_between(
        d_km, fresnel_lower, fresnel_upper,
        alpha=0.15, color="#ffd166", zorder=4,
    )
    ax.plot(d_km, fresnel_upper, color="#ffd166", linewidth=0.5, alpha=0.5, zorder=4)
    ax.plot(d_km, fresnel_lower, color="#ffd166", linewidth=0.5, alpha=0.5, zorder=4)

    # ── Obstruction markers ──
    obstructed_mask = clearance < 0
    if obstructed_mask.any():
        ax.scatter(
            d_km[obstructed_mask],
            eff_terrain[obstructed_mask],
            color="#ef476f", s=20, zorder=6,
            marker="^",
        )

    # ── GATEWAY marker (blue, left, position 0) ──
    gw_ground = float(elevations[0])
    ax.plot([d_km[0], d_km[0]], [gw_ground, h_tx_asl],
            color="#118ab2", linewidth=2, zorder=7)
    ax.plot(d_km[0], h_tx_asl, "s", color="#118ab2", markersize=10, zorder=8)
    # Blue box label
    ax.annotate(
        f"GATEWAY\n{gw_ground:.0f}m ground\n{h_tx_asl:.1f}m antenna",
        (d_km[0], h_tx_asl),
        textcoords="offset points", xytext=(12, 10),
        fontsize=8, fontweight="bold", color="white",
        bbox=dict(boxstyle="round,pad=0.4", facecolor="#118ab2", alpha=0.85),
        zorder=9,
    )

    # ── NODE marker (green, right, position -1) ──
    node_ground = float(elevations[-1])
    ax.plot([d_km[-1], d_km[-1]], [node_ground, h_rx_asl],
            color="#06d6a0", linewidth=2, zorder=7)
    ax.plot(d_km[-1], h_rx_asl, "s", color="#06d6a0", markersize=10, zorder=8)
    # Green box label
    ax.annotate(
        f"NODE\n{node_ground:.0f}m ground\n{h_rx_asl:.1f}m antenna",
        (d_km[-1], h_rx_asl),
        textcoords="offset points", xytext=(-12, 10),
        fontsize=8, fontweight="bold", color="white",
        ha="right",
        bbox=dict(boxstyle="round,pad=0.4", facecolor="#06d6a0", alpha=0.85),
        zorder=9,
    )

    # ── Worst clearance annotation ──
    worst_idx = los_analysis["worst_point_idx"]
    min_pct = los_analysis["min_clearance_pct"]
    if 0 < worst_idx < len(d_km) - 1:
        wx = d_km[worst_idx]
        wy = eff_terrain[worst_idx]
        color = "#ef476f" if min_pct < 60 else "#ffd166"
        ax.annotate(
            f"Min clearance: {min_pct:.0f}%",
            (wx, wy),
            textcoords="offset points", xytext=(0, -25),
            fontsize=9, color=color,
            arrowprops=dict(arrowstyle="->", color=color, lw=0.8),
            ha="center",
        )

    # ── Legend as text inside axes (survives Streamlit rendering) ──
    legend_text = (
        "── Terrain    --- Eff. terrain (k=4/3)    ── LOS    "
        "█ Fresnel F1    ▲ Obstruction"
    )
    ax.text(
        0.5, 0.97, legend_text,
        transform=ax.transAxes,
        fontsize=7, color="#adb5bd",
        ha="center", va="top",
        bbox=dict(boxstyle="round,pad=0.3", facecolor="#1a1a2e",
                  edgecolor="#495057", alpha=0.9),
    )

    # ── Styling ──
    ax.set_xlim(d_km[0], d_km[-1])
    ax.set_ylim(y_min - y_pad, y_max + y_pad)
    ax.set_xlabel("Distance (km)", color="#adb5bd", fontsize=11)
    ax.set_ylabel("Elevation (m ASL)", color="#adb5bd", fontsize=11)
    ax.set_title(title, color="#e9ecef", fontsize=13, fontweight="bold", pad=12)
    ax.tick_params(colors="#6c757d")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["bottom"].set_color("#495057")
    ax.spines["left"].set_color("#495057")
    ax.grid(True, alpha=0.15, color="#495057")

    fig.tight_layout()
    return fig


def get_elevation_summary(terrain: TerrainProfile, h_tx_agl: float, h_rx_agl: float) -> dict:
    """
    Return elevation summary data for display below the chart.

    Parameters
    ----------
    terrain : TerrainProfile
        Terrain profile data.
    h_tx_agl : float
        Gateway antenna height above ground (AGL).
    h_rx_agl : float
        Node antenna height above ground (AGL).

    Returns
    -------
    dict with keys:
        tx_ground : ground elevation at gateway (pos 0)
        rx_ground : ground elevation at node (pos -1)
        tx_asl : antenna height ASL at gateway
        rx_asl : antenna height ASL at node
        delta : elevation difference (tx_ground - rx_ground)
        max_terrain : maximum terrain elevation along path
        min_terrain : minimum terrain elevation along path
        source : elevation data source name
    """
    tx_ground = float(terrain.elevations[0])
    rx_ground = float(terrain.elevations[-1])

    return {
        "tx_ground": tx_ground,
        "rx_ground": rx_ground,
        "tx_asl": tx_ground + h_tx_agl,
        "rx_asl": rx_ground + h_rx_agl,
        "delta": tx_ground - rx_ground,
        "max_terrain": float(np.max(terrain.elevations)),
        "min_terrain": float(np.min(terrain.elevations)),
        "source": terrain.elevation_source,
    }
