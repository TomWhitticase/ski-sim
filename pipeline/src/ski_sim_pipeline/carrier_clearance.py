"""Carriers clear the ground: every chair, gondola and cabin, all along both tracks.

The tower placement (`features._fill_span`) and the approach walk (`approach.py`) work on
the rope's height above the ground. What has to clear it is the carrier hanging under the
rope: a cable car cabin's floor is 7.5 m down, and it hangs plumb, so on a steep arrival
its downhill end is lower still than under the grip. This module is the carrier's own
envelope, mirroring what the sim draws (`sim/src/lifts/carriers.ts`: `cabinLayout`, the
chair and its rider's skis; hang depths from `operation.ts`):

- `shortfalls` walks every span at `STEP` m, for both tracks, and compares each
  carrier's underside with the highest ground under its footprint (its length along the
  line by its width across). Out on the line it must clear the ground by its `MARGIN`; that
  tapers to nothing over `PLATFORM_RUN` m outside a hall, where the carrier comes down
  to the platform. Ground inside the lift's own halls (and within `MOUTH` in front) is
  the platform and isn't checked, nor are carriers whose grip is still in a hall.
- `raise_towers`, after the approach walk and crossings: out on the line, the towers
  either side of anything still too low go up, within buildable heights.
- `notch` is the last resort, for what no tower can fix (no new tower stands within
  `NOTCH_REACH` of a station's exit): there it cuts the terrain under the carriers down
  to clear them (a blasted rock cut or platform edge, as real stations on a cliff top
  have), with steep banks back to the natural ground, never into a hall, round its
  loading points or under a tower. Every notch is recorded as synthetic.
- `validate` is the check over the finished build (logged, `manifest.validation`).

Drags and rope tows are left out: their riders are on the snow.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np

from . import rope
from .grid import Grid

log = logging.getLogger(__name__)

#: Carrier underside above the ground out on the line (m), by kind: a chair's skis may
#: skim lower (a minimum 4 m tower holds them ~1.2 m up) than a cabin's floor.
MARGIN = {"chair": 0.5, "gondola": 1.0, "cabin": 1.0}
#: Over this many metres outside a hall's exit the margin tapers from nothing to MARGIN.
PLATFORM_RUN = 15.0
#: Shortfalls up to this are rounding: a cabin's floor slab is 8 cm under the platform,
#: and the sim sets a gondola's rail from its own cabin size, a few cm off `approach.RAIL`.
TOLERANCE = 0.25
#: Spacing of the carrier positions checked along the line (m).
STEP = 2.0
#: Only this close to a hall's exit (m) may the terrain be notched for the carriers.
NOTCH_REACH = 40.0
#: A notch cuts this much deeper than it has to (m), so terrain LODs stay clear.
NOTCH_EXTRA = 0.3
#: Notch walls: how steeply they rise back to the ground (rise over run; ~63°), and how
#: far out they're blended (m).
NOTCH_BANK = 2.0
NOTCH_BANK_REACH = 20.0
#: The platform's edge: ground this close outside a hall's exit, in front of it, is where
#: a carrier comes down to the platform (a cabin nosing in on a steep arrival dips below
#: it), so it isn't checked (m).
MOUTH = 3.0
#: Passes a notch takes to deepen where the terrain's bilinear blend with the protected
#: hall still leaves a carrier touching.
NOTCH_PASSES = 4

#: Hang depth of the grip's carrier below the rope in the sim (`operation.ts`): a chair's
#: cushion, a gondola's or cabin's mid-height.
SIM_HANG = {"chair": 2.4, "gondola": 3.2, "cabin": 6.0}
#: A chair's footrest is 0.2 m under the cushion; the rider's skis rest on it, their
#: tips and tails hanging a little lower, ~1 m either way along the line.
CHAIR_SKIS_BELOW_SEAT = 0.45
CHAIR_SKI_HALF_LENGTH = 1.0
#: Per seat, half a chair's width (m).
CHAIR_HALF_WIDTH_PER_SEAT = 0.25
#: A cabin's floor slab under its floor (m).
SLAB = 0.08


@dataclass(frozen=True)
class Carrier:
    depth: float  # underside below the rope (m)
    half_length: float  # along the line
    half_width: float  # across it
    margin: float  # above the ground out on the line


def carrier(lift: dict) -> Carrier | None:
    """The carrier's envelope as the sim draws it, or None for drags and tows."""
    from .terminals import KIND

    kind = KIND.get(lift["type"])
    occupancy = lift.get("occupancy")
    if kind == "chair":
        seats = max(1, round(occupancy or 4))
        return Carrier(
            SIM_HANG["chair"] + CHAIR_SKIS_BELOW_SEAT,
            CHAIR_SKI_HALF_LENGTH,
            CHAIR_HALF_WIDTH_PER_SEAT * seats + 0.1,
            MARGIN["chair"],
        )
    if kind == "gondola":
        # cabinLayout('gondola'): s = cbrt(max(seats, 4) / 8), h = 2 min(s, 1.15).
        s = (max(round(occupancy or 8), 4) / 8) ** (1 / 3)
        h = 2.0 * min(s, 1.15)
        return Carrier(
            SIM_HANG["gondola"] + h / 2 + SLAB, 1.9 * s / 2, 1.75 * s / 2, MARGIN["gondola"]
        )
    if kind == "cabin":
        # cabinLayout('cabin'): s = cbrt(max(seats, 40) / 120), floor 1.45 under the hang.
        s = (max(round(occupancy or 4), 40) / 120) ** (1 / 3)
        return Carrier(SIM_HANG["cabin"] + 1.45 + SLAB, 6.5 * s / 2, 3.6 * s / 2, MARGIN["cabin"])
    return None


def margin(x: np.ndarray, full: float) -> np.ndarray:
    """Clearance needed `x` m outside the nearest hall's exit, `full` out on the line."""
    return full * np.clip(np.asarray(x, dtype=float) / PLATFORM_RUN, 0.0, 1.0)


def _across(lift: dict) -> np.ndarray:
    # One across vector for the whole line, from the bottom to the top station (as the sim).
    s = lift["supports"]
    d = np.array([s[-1]["east"] - s[0]["east"], s[-1]["north"] - s[0]["north"]], dtype=float)
    d /= max(float(np.hypot(*d)), 1e-6)
    return np.array([d[1], -d[0]])


def _rope_heights(a: dict, b: dict, d: np.ndarray, catenary) -> np.ndarray:
    return np.array([rope.along(a, b, float(x), catenary) for x in d])


def _terminal_frame(terms: list[dict], e: np.ndarray, n: np.ndarray, mouth: float = 0.0):
    """For points (e, n): inside any of the halls (or within `mouth` m in front of one),
    and metres outside the nearest exit."""
    inside = np.zeros(e.shape, dtype=bool)
    outside = np.full(e.shape, np.inf)
    nearest = np.full(e.shape, -1, dtype=int)
    for i, t in enumerate(terms):
        de, dn = e - t["east"], n - t["north"]
        u = de * t["dir"][0] + dn * t["dir"][1]
        v = de * t["across"][0] + dn * t["across"][1]
        in_hall = (u >= -t["back"]) & (u <= t["length"] + mouth)
        in_hall &= np.abs(v) <= t["width"] / 2 + 1.0
        inside |= in_hall
        x = np.where(np.abs(v) <= t["width"] / 2 + 15.0, np.maximum(u - t["length"], 0.0), np.inf)
        x = np.where(u < -t["back"], np.inf, x)
        closer = x < outside
        outside = np.where(closer, x, outside)
        nearest = np.where(closer, i, nearest)
    return inside, outside, nearest


@dataclass
class Samples:
    """Carrier positions along a lift: grip plan position, underside height, shortfall
    (positive: into the ground by that much), how far outside the nearest exit, and
    which terminal that is (index into the lift's terminals, -1 none)."""

    east: np.ndarray
    north: np.ndarray
    along: np.ndarray  # plan distance from the bottom station (m)
    span: np.ndarray  # index of the support the span starts at
    side: np.ndarray
    bottom: np.ndarray
    shortfall: np.ndarray
    outside: np.ndarray
    nearest: np.ndarray


def shortfalls(lift: dict, terms: list[dict], ground, c: Carrier | None = None) -> Samples | None:
    """Every carrier position along both tracks of `lift` against the ground."""
    c = c or carrier(lift)
    supports = lift["supports"]
    if c is None or len(supports) < 2:
        return None
    across = _across(lift)
    r = lift["gauge"] / 2
    out: dict[str, list] = {k: [] for k in Samples.__dataclass_fields__}
    start = 0.0
    for k, (a, b) in enumerate(zip(supports, supports[1:], strict=False)):
        span = math.hypot(b["east"] - a["east"], b["north"] - a["north"])
        if span < 1e-3:
            continue
        u = np.array([(b["east"] - a["east"]) / span, (b["north"] - a["north"]) / span])
        d = np.append(np.arange(0.0, span, STEP), span)
        h = _rope_heights(a, b, d, lift.get("catenary"))
        bottom = h - c.depth
        for side in (-1.0, 1.0):
            ge = a["east"] + u[0] * d + across[0] * side * r
            gn = a["north"] + u[1] * d + across[1] * side * r
            # A carrier whose grip is in a hall is in the station: nothing to clear. Out of
            # it, the margin it needs grows with how far out it is.
            inside, x, nearest = _terminal_frame(terms, ge, gn)
            need = margin(x, c.margin) - bottom
            # The carrier's footprint: 3 x 3 points over its length and width.
            worst = np.full(d.shape, -np.inf)
            for fa in (-c.half_length, 0.0, c.half_length):
                for fw in (-c.half_width, 0.0, c.half_width):
                    pe = ge + u[0] * fa + across[0] * fw
                    pn = gn + u[1] * fa + across[1] * fw
                    on_pad, _, _ = _terminal_frame(terms, pe, pn, MOUTH)
                    under = np.asarray(ground(pe, pn), dtype=float) + need
                    worst = np.maximum(worst, np.where(on_pad, -np.inf, under))
            worst = np.where(inside, -np.inf, worst)
            out["east"].append(ge)
            out["north"].append(gn)
            out["along"].append(start + d)
            out["span"].append(np.full(d.shape, k))
            out["side"].append(np.full(d.shape, side))
            out["bottom"].append(bottom)
            out["shortfall"].append(worst)
            out["outside"].append(x)
            out["nearest"].append(nearest)
        start += span
    return Samples(**{k: np.concatenate(v) for k, v in out.items()})


def span_shortfall(a: dict, b: dict, lift: dict, ground, beyond: float = 0.0) -> float:
    """Worst carrier shortfall between supports a and b, ignoring positions within
    `beyond` m of either end (m; -inf if none)."""
    sub = {**lift, "supports": [a, b]}
    s = shortfalls(sub, [], ground)
    if s is None:
        return -math.inf
    span = math.hypot(b["east"] - a["east"], b["north"] - a["north"])
    keep = (s.along >= beyond) & (s.along <= span - beyond)
    return float(s.shortfall[keep].max()) if keep.any() else -math.inf


def conflicts(lift: dict, terms: list[dict], ground) -> list[dict]:
    """Stretches of line where a carrier would touch the ground, worst first."""
    s = shortfalls(lift, terms, ground)
    if s is None:
        return []
    bad = s.shortfall > TOLERANCE
    if not bad.any():
        return []
    out = []
    order = np.argsort(s.along)
    along, short = s.along[order], s.shortfall[order]
    nearest, outside = s.nearest[order], s.outside[order]
    flagged = bad[order]
    # Group flagged positions into stretches (gaps of more than 3 steps split them).
    run: list[int] = []
    for i in np.flatnonzero(flagged):
        if run and along[i] - along[run[-1]] > 3 * STEP:
            out.append(_stretch(lift, terms, along, short, nearest, outside, run))
            run = []
        run.append(int(i))
    if run:
        out.append(_stretch(lift, terms, along, short, nearest, outside, run))
    return sorted(out, key=lambda c: -c["shortfall"])


def _stretch(lift, terms, along, short, nearest, outside, run) -> dict:
    worst = run[int(np.argmax(short[run]))]
    near = int(nearest[worst])
    return {
        "lift": lift["id"],
        "name": lift.get("name"),
        "type": lift["type"],
        "from": round(float(along[run[0]]), 1),
        "to": round(float(along[run[-1]]), 1),
        "shortfall": round(float(short[worst]), 2),
        "station": terms[near]["end"] if near >= 0 and outside[worst] <= NOTCH_REACH else None,
        "outside": round(float(outside[worst]), 1) if np.isfinite(outside[worst]) else None,
    }


def _halls(all_terms: list[dict], east: np.ndarray, north: np.ndarray, reach: float = 0.0):
    """Mask of grid points inside any terminal's hall, or within `reach` of its loading
    and unloading points (never notched: riders load and unload on that ground, and the
    sim checks it's on the pad)."""
    mask = np.zeros(east.shape, dtype=bool)
    for t in all_terms:
        de, dn = east - t["east"], north - t["north"]
        u = de * t["dir"][0] + dn * t["dir"][1]
        v = de * t["across"][0] + dn * t["across"][1]
        mask |= (u >= -t["back"] - 1.0) & (u <= t["length"]) & (np.abs(v) <= t["width"] / 2 + 1.0)
        r = t.get("gauge", 0.0) / 2
        for at in (t.get("load"), t.get("unload")):
            if at is not None:
                for side in (-r, r):
                    mask |= (u - at) ** 2 + (v - side) ** 2 <= reach * reach
    return mask


def notch(
    lifts: list[dict],
    terms_by_lift: dict[int, list[dict]],
    heights: np.ndarray,
    grid: Grid,
    ground,
) -> list[dict]:
    """Cut the terrain (in place) under carriers that would touch it within NOTCH_REACH of
    a hall's exit. Returns a record per notched station end."""
    all_terms = [t for ts in terms_by_lift.values() for t in ts]
    # Towers keep their footing: a tower was sized for its carriers on that ground.
    towers = np.array(
        [(x["east"], x["north"]) for li in lifts for x in li["supports"] if x["kind"] != "station"]
        or np.zeros((0, 2))
    )
    records = []
    for lift in lifts:
        terms = terms_by_lift.get(lift["id"], [])
        c = carrier(lift)
        if c is None or len(terms) != 2:
            continue
        # Bilinear sampling blends a cut cell with its uncut (or protected) neighbours, so
        # what's still short after a pass is cut deeper by that much, twice over.
        deepen = None
        for _ in range(NOTCH_PASSES):
            s = shortfalls(lift, terms, ground, c)
            hit = (s.shortfall > TOLERANCE) & (s.outside <= NOTCH_REACH) & (s.nearest >= 0)
            if not hit.any():
                break
            if deepen is None:
                deepen = np.zeros(s.shortfall.shape)
            else:
                deepen = np.where(hit, deepen + 2 * np.maximum(s.shortfall, 0), deepen)
            records += _notch_lift(lift, terms, all_terms, towers, s, hit, deepen, c, heights, grid)
    return merge_notches(records)


def _notch_lift(lift, terms, all_terms, towers, s, hit, deepen, c, heights, grid) -> list[dict]:
    """One pass of `notch` for one lift: cut under its flagged carriers (`hit`), each
    `deepen` m deeper than it needs."""
    cell = grid.cell_size
    ext = grid.extent
    pad = 1.5 * cell  # bilinear: every corner of the cell under a point is this close
    records = []
    across = _across(lift)
    for ti in sorted(set(s.nearest[hit].tolist())):
        t = terms[ti]
        sel = np.flatnonzero(hit & (s.nearest == ti))
        # Cells around this end's flagged carriers, then their target heights.
        reach = c.half_length + c.half_width + pad + NOTCH_BANK_REACH
        e0, e1 = s.east[sel].min() - reach, s.east[sel].max() + reach
        n0, n1 = s.north[sel].min() - reach, s.north[sel].max() + reach
        c0 = max(int((e0 - ext.west) / cell), 0)
        c1 = min(int((e1 - ext.west) / cell) + 1, grid.width - 1)
        r0 = max(int((ext.north - n1) / cell), 0)
        r1 = min(int((ext.north - n0) / cell) + 1, grid.height - 1)
        if c0 > c1 or r0 > r1:
            continue
        cols, rows = np.arange(c0, c1 + 1), np.arange(r0, r1 + 1)
        east = np.broadcast_to(ext.west + cols[np.newaxis, :] * cell, (len(rows), len(cols)))
        north = np.broadcast_to(ext.north - rows[:, np.newaxis] * cell, (len(rows), len(cols)))
        target = np.full(east.shape, np.inf)
        dirv = np.array(t["dir"]) * -1.0  # down the line from this end
        for i in sel:
            de, dn = east - s.east[i], north - s.north[i]
            fa = de * dirv[0] + dn * dirv[1]
            fw = de * across[0] + dn * across[1]
            inside = (np.abs(fa) <= c.half_length + pad) & (np.abs(fw) <= c.half_width + pad)
            level = s.bottom[i] - float(margin(s.outside[i], c.margin)) - NOTCH_EXTRA
            level -= deepen[i]
            target = np.where(inside, np.minimum(target, level), target)
        protected = _halls(all_terms, east, north, pad + 1.0)
        for te, tn in towers:
            if e0 - pad <= te <= e1 + pad and n0 - pad <= tn <= n1 + pad:
                protected |= (east - te) ** 2 + (north - tn) ** 2 <= (pad + 1.0) ** 2
        target[protected] = np.inf
        cut = np.isfinite(target)
        if not cut.any():
            continue
        # Banks: back up to the natural ground at NOTCH_BANK, as far as NOTCH_BANK_REACH.
        ce, cn, ct = east[cut], north[cut], target[cut]
        bank = np.full(east.shape, np.inf)
        for k in range(len(ct)):
            dist = np.sqrt((east - ce[k]) ** 2 + (north - cn[k]) ** 2)
            near = dist <= NOTCH_BANK_REACH
            bank = np.where(near, np.minimum(bank, ct[k] + NOTCH_BANK * dist), bank)
        bank[protected] = np.inf
        goal = np.minimum(target, bank)
        block = heights[r0 : r1 + 1, c0 : c1 + 1]
        lowered = np.minimum(block, goal)
        depth = block - lowered
        if not (depth > 1e-3).any():
            continue
        heights[r0 : r1 + 1, c0 : c1 + 1] = lowered.astype(heights.dtype)
        dug = depth > 1e-3
        records.append(
            {
                "lift": lift["id"],
                "name": lift.get("name"),
                "end": t["end"],
                "cells": int(dug.sum()),
                "area": round(float(dug.sum()) * cell * cell, 1),
                "maxDepth": round(float(depth.max()), 2),
                "volume": round(float(depth.sum()) * cell * cell, 1),
                "synthetic": True,
            }
        )
    return records


def raise_towers(lifts: list[dict], terms_by_lift: dict[int, list[dict]], ground) -> int:
    """Out on the line, beyond a notch's reach, raise the towers either side of wherever a
    carrier still touches (the nearer one first; within buildable heights; never a tower
    set for a crossing, which would close it up again). Returns towers raised."""
    from .features import LIFT_PROFILES, MAX_TOWER_FACTOR

    raised = set()
    for lift in lifts:
        terms = terms_by_lift.get(lift["id"], [])
        profile = LIFT_PROFILES.get(lift["type"])
        if len(terms) != 2 or profile is None or carrier(lift) is None:
            continue
        supports = lift["supports"]
        for _ in range(12):
            s = shortfalls(lift, terms, ground)
            bad = (s.shortfall > TOLERANCE) & ~(s.outside <= NOTCH_REACH)
            if not bad.any():
                break
            worst = int(np.argmax(np.where(bad, s.shortfall, -np.inf)))
            k = int(s.span[worst])
            a, b = supports[k], supports[k + 1]
            span = math.hypot(b["east"] - a["east"], b["north"] - a["north"])
            u = (s.along[worst] - (s.along[s.span == k].min())) / max(span, 1e-6)
            moved = False
            for sup, w in sorted(((a, 1 - u), (b, u)), key=lambda x: -x[1]):
                if sup["kind"] == "station" or sup.get("crossing") or w < 0.05:
                    continue
                high = sup["ground"] + profile.tower_height * MAX_TOWER_FACTOR
                want = min(sup["top"] + (s.shortfall[worst] + 0.2) / w, high)
                if want > sup["top"] + 0.05:
                    sup["top"] = round(want, 2)
                    sup["adjusted"] = True
                    raised.add(id(sup))
                    moved = True
                    break
            if not moved:
                break
    return len(raised)


def merge_notches(records: list[dict]) -> list[dict]:
    """One record per notched station end (a second pass can cut the same one again)."""
    merged: dict[tuple, dict] = {}
    for r in records:
        key = (r["lift"], r["end"])
        if key not in merged:
            merged[key] = dict(r)
            continue
        m = merged[key]
        for k in ("cells", "area", "volume"):
            m[k] = round(m[k] + r[k], 1) if isinstance(m[k], float) else m[k] + r[k]
        m["maxDepth"] = max(m["maxDepth"], r["maxDepth"])
    return list(merged.values())


def reseat_towers(lifts: list[dict], ground) -> int:
    """Towers stand on the ground: after a notch, re-sample their footing heights (their
    tops, and so the rope, stay)."""
    moved = 0
    for lift in lifts:
        for s in lift["supports"]:
            if s["kind"] == "station":
                continue
            g = float(np.asarray(ground(np.array([s["east"]]), np.array([s["north"]])))[0])
            if g < s["ground"] - 0.05:
                s["ground"] = round(g, 2)
                moved += 1
    return moved


def validate(lifts: list[dict], ground) -> dict:
    """Carrier clearance over every lift (each with its `terminals`)."""
    found = []
    checked = 0
    for lift in lifts:
        terms = lift.get("terminals") or []
        if carrier(lift) is None or len(terms) != 2:
            continue
        checked += 1
        found += conflicts(lift, terms, ground)
    found.sort(key=lambda c: -c["shortfall"])
    return {
        "checked": checked,
        "margin": MARGIN,
        "platformRun": PLATFORM_RUN,
        "step": STEP,
        "conflicts": found,
    }
