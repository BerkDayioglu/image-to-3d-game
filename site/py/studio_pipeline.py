"""img2threejs Studio — browser adapter around the img2threejs forge pipeline.

Runs inside Pyodide (and under plain CPython for local testing). It never re-implements the
forge: every stage is the original img2threejs script, executed with the same argv a local
Claude Code / Codex session would use. The only thing added here is `expand_brief`, which
turns the compact JSON "SculptBrief" written by the vision LLM into the full ObjectSculptSpec
layout that `validate_sculpt_spec.py --strict-quality` and `generate_threejs_factory.py` read.
"""

from __future__ import annotations

import contextlib
import copy
import importlib
import io
import json
import math
import os
import runpy
import sys
import traceback
from pathlib import Path
from typing import Any

FORGE_ROOT = Path(os.environ.get("IMG2THREEJS_ROOT", "/img2threejs"))
WORK = Path(os.environ.get("IMG2THREEJS_WORK", "/work"))

# ---------------------------------------------------------------------------------------------
# Running the original forge scripts
# ---------------------------------------------------------------------------------------------


def run_script(relpath: str, args: list[str]) -> dict[str, Any]:
    """Execute one forge script exactly like `python3 <relpath> <args...>`."""
    script = FORGE_ROOT / relpath
    out, err = io.StringIO(), io.StringIO()
    old_argv, old_cwd = sys.argv, os.getcwd()
    code = 0
    try:
        sys.argv = [str(script), *args]
        os.chdir(FORGE_ROOT)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                runpy.run_path(str(script), run_name="__main__")
            except SystemExit as exc:  # argparse / explicit exit codes
                code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
            except Exception:  # noqa: BLE001 - surfaced to the UI log verbatim
                code = 1
                err.write(traceback.format_exc())
    finally:
        sys.argv = old_argv
        os.chdir(old_cwd)
    return {
        "command": "python3 " + " ".join([relpath, *[_quote(a) for a in args]]),
        "script": relpath,
        "exitCode": code,
        "stdout": out.getvalue(),
        "stderr": err.getvalue(),
    }


def _quote(value: str) -> str:
    return f'"{value}"' if (" " in value or not value) else value


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def probe(image_path: str) -> dict[str, Any]:
    step = run_script("forge/stage1_intake/probe_image.py", [image_path])
    try:
        step["result"] = json.loads(step["stdout"])
    except json.JSONDecodeError:
        step["result"] = None
    return step


def safe_name(value: Any) -> str:
    """targetName is written verbatim into a `//` comment of the generated factory, so it must
    stay on one line and free of comment/escape characters (it comes from the LLM)."""
    text = "".join(ch if (ch.isalnum() or ch in " -_.()'") else " " for ch in str(value or ""))
    text = " ".join(text.split())[:80]
    return text or "Procedural Object"


def starter_spec(name: str, image_path: str, complexity: str) -> dict[str, Any]:
    """Stage 2 skeleton: pre-spec assessment + starter ObjectSculptSpec (original scripts)."""
    name = safe_name(name)
    WORK.mkdir(parents=True, exist_ok=True)
    assessment = WORK / "assessment.json"
    spec_path = WORK / "object-sculpt-spec.json"
    if complexity not in {"simple", "moderate", "complex", "ultra-complex"}:
        complexity = "moderate"
    steps = [
        run_script(
            "forge/stage2_spec/new_pre_spec_assessment.py",
            [name, "--image", image_path, "--complexity", complexity, "--out", str(assessment), "--force"],
        )
    ]
    steps.append(
        run_script(
            "forge/stage2_spec/new_sculpt_spec.py",
            [name, "--image", image_path, "--assessment", str(assessment), "--out", str(spec_path), "--force"],
        )
    )
    spec = _load_json(spec_path) if spec_path.exists() else None
    return {"steps": steps, "spec": spec}


# ---------------------------------------------------------------------------------------------
# SculptBrief -> ObjectSculptSpec
# ---------------------------------------------------------------------------------------------

PRIMITIVE_ALIASES = {
    "cube": "box",
    "rounded-box": "box",
    "roundedbox": "box",
    "ball": "sphere",
    "cylinder-tapered": "cylinder",
    "pyramid": "cone",
    "ring": "torus",
    "donut": "torus",
    "revolve": "lathe",
    "plane": "plane-card",
    "card": "plane-card",
    "sweep": "tapered-sweep",
    "pipe": "tube",
}
SUPPORTED = {
    "box", "sphere", "ellipsoid", "cylinder", "cone", "capsule", "torus", "tube",
    "lathe", "extrude", "tapered-sweep", "plane-card", "curve-sweep",
}
# Children built from these primitives get their geometry from attachment endpoints.
ENDPOINT_PRIMITIVES = {"cylinder", "cone", "capsule"}
LEVELS = {"macro", "meso", "micro"}
PHYSICAL_KEYS = ("clearcoat", "transmission", "sheen", "iridescence")
MATERIAL_CLASSES = ("metal", "plastic", "wood", "fabric", "skin", "glass", "ceramic", "rubber", "stone")
MATERIAL_CLASS_HINTS = {
    "metal": ("metal", "steel", "iron", "brass", "gold", "silver", "chrome", "alumin", "copper", "bronze"),
    "plastic": ("plastic", "polymer", "vinyl", "acrylic", "resin", "paint", "lacquer", "composite"),
    "wood": ("wood", "timber", "oak", "bamboo", "bark", "plywood"),
    "fabric": ("fabric", "cloth", "textile", "leather", "canvas", "wool", "felt", "cotton", "denim", "fur"),
    "skin": ("skin", "flesh"),
    "glass": ("glass", "crystal", "transparent", "gem", "ice"),
    "ceramic": ("ceramic", "porcelain", "clay", "glaze", "enamel", "terracotta"),
    "rubber": ("rubber", "silicone", "tire", "tyre", "foam"),
    "stone": ("stone", "rock", "concrete", "marble", "granite", "brick", "sand"),
}
DETAIL_KINDS = {
    "gloss", "bevel", "fastener", "linework", "contour", "seam", "stitch",
    "stain", "scratch", "chip", "decal", "emissive", "hole", "groove", "ridge",
}
DETAIL_KIND_ALIASES = {
    "wear": "scratch", "scuff": "scratch", "dent": "chip", "screw": "fastener", "rivet": "fastener",
    "bolt": "fastener", "print": "decal", "logo": "decal", "text": "decal", "label": "decal",
    "light": "emissive", "glow": "emissive", "edge": "bevel", "fillet": "bevel", "line": "linework",
    "pattern": "linework", "shape": "contour", "silhouette": "contour", "dirt": "stain", "rust": "stain",
    "vent": "hole", "slot": "groove", "rib": "ridge", "shine": "gloss", "specular": "gloss",
}


def material_class(m: dict[str, Any]) -> str:
    explicit = str(m.get("materialClass") or "").lower()
    if explicit in MATERIAL_CLASSES:
        return explicit
    text = " ".join(str(m.get(k) or "") for k in ("materialClass", "finish", "name", "id")).lower()
    for cls, hints in MATERIAL_CLASS_HINTS.items():
        if any(h in text for h in hints):
            return cls
    return "unknown"


def detail_kind(value: Any) -> str:
    kind = str(value or "").lower().strip()
    if kind in DETAIL_KINDS:
        return kind
    for alias, target in DETAIL_KIND_ALIASES.items():
        if alias in kind:
            return target
    return "contour"


PRIMARY_VIEW_ID = "full-object"
VIEW_ANGLES = {
    "front": "front elevation",
    "three-quarter": "three-quarter view",
    "side": "side elevation",
    "back": "rear elevation",
    "top": "top-down view",
    "bottom": "underside view",
    "detail": "close-up detail",
    "other": "additional view",
}


def view_id(index: int, angle: str) -> str:
    """Stable viewEvidence id. The first reference keeps the starter spec's id so the
    qualityContract feature groups authored by new_sculpt_spec.py stay resolvable."""
    if index == 0:
        return PRIMARY_VIEW_ID
    angle = angle if angle in VIEW_ANGLES else "other"
    return f"view-{index + 1}-{angle}"


def _num(value: Any, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return float(value)


def _vec3(value: Any, default: list[float]) -> list[float]:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        return [round(_num(v, d), 5) for v, d in zip(value, default)]
    return list(default)


def _hex(value: Any, default: str = "#8a8a8a") -> str:
    if isinstance(value, str):
        text = value.strip()
        if not text.startswith("#"):
            text = "#" + text
        if len(text) == 4:
            text = "#" + "".join(ch * 2 for ch in text[1:])
        try:
            int(text[1:], 16)
            if len(text) == 7:
                return text.lower()
        except ValueError:
            pass
    return default


def _rgba(hex_color: str) -> str:
    v = int(hex_color[1:], 16)
    return f"rgba({(v >> 16) & 255}, {(v >> 8) & 255}, {v & 255}, 1.0)"


def _shade(hex_color: str, factor: float) -> str:
    v = int(hex_color[1:], 16)
    parts = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    parts = [max(0, min(255, round(p * factor))) for p in parts]
    return "#" + "".join(f"{p:02x}" for p in parts)


def _slug(value: Any, fallback: str) -> str:
    text = "".join(ch if ch.isalnum() else "-" for ch in str(value or "")).strip("-")
    while "--" in text:
        text = text.replace("--", "-")
    return text or fallback


def _strings(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int, float)) and str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value]
    return []


def _refs(value: Any, view_ids: list[str]) -> list[str]:
    """Keep only evidence ids that exist in viewEvidence (the validator rejects unknown ones)."""
    refs = [v for v in _strings(value) if v in view_ids]
    return refs or [view_ids[0]]


def _rotate(vec: list[float], rot: list[float]) -> list[float]:
    """Apply an XYZ-order Euler rotation (three.js default) to a vector."""
    x, y, z = vec
    rx, ry, rz = rot
    # three.js 'XYZ' Euler => matrix = Rx * Ry * Rz, applied to column vectors.
    cz, sz = math.cos(rz), math.sin(rz)
    x, y = x * cz - y * sz, x * sz + y * cz
    cy, sy = math.cos(ry), math.sin(ry)
    x, z = x * cy + z * sy, -x * sy + z * cy
    cx, sx = math.cos(rx), math.sin(rx)
    y, z = y * cx - z * sx, y * sx + z * cx
    return [x, y, z]


def _expand_material(template: dict[str, Any], m: dict[str, Any], index: int) -> dict[str, Any]:
    mat = copy.deepcopy(template)
    mat_id = _slug(m.get("id"), f"material-{index}")
    base = _hex(m.get("baseColor"))
    secondary = [_hex(c, base) for c in (m.get("secondary") or [])][:3]
    if not secondary:
        secondary = [_shade(base, 1.12), _shade(base, 0.82)]
    roughness = min(1.0, max(0.0, _num(m.get("roughness"), 0.6)))
    metalness = min(1.0, max(0.0, _num(m.get("metalness"), 0.0)))
    texture = min(1.0, max(0.0, _num(m.get("textureStrength"), 0.35)))
    physical = metalness > 0.5 or any(_num(m.get(k), 0) > 0 for k in PHYSICAL_KEYS)

    mat.update(
        {
            "id": mat_id,
            "name": str(m.get("name") or mat_id),
            "type": "physical" if physical else "standard",
            "shaderModel": "MeshPhysicalMaterial / PBR approximation" if physical else "MeshStandardMaterial / PBR approximation",
            "baseColor": base,
            "color": base,
            "finishClass": str(m.get("finish") or "unspecified"),
        }
    )
    mat["albedo"] = {
        "dominant": base,
        "secondary": secondary,
        "samplingNotes": str(
            m.get("samplingNotes")
            or "Estimated by the vision model from the reference photo; not spectrophotometric."
        ),
    }
    mat["colorVariation"] = {
        "palette": [base, *secondary],
        "pattern": str(m.get("pattern") or "mottled"),
        "amplitude": round(0.02 + 0.16 * texture, 3),
        "heightCorrelation": round(0.1 + 0.25 * texture, 3),
    }
    mat["surfaceFrequencyBands"] = [
        {"id": "macro", "frequency": 2.0, "amplitude": round(0.04 + 0.38 * texture, 3), "role": "broad color and value breakup"},
        {"id": "meso", "frequency": 12.0, "amplitude": round(0.02 + 0.2 * texture, 3), "role": "grain, pores, brushing or equivalent visible relief"},
        {"id": "micro", "frequency": 56.0, "amplitude": round(0.01 + 0.07 * texture, 3), "role": "highlight breakup under grazing light"},
    ]
    mat["roughness"] = {
        "base": round(roughness, 3),
        "variation": round(0.03 + 0.12 * texture, 3),
        "map": "independent-procedural-field",
        "localResponse": str(m.get("roughnessNotes") or "slightly lower roughness on worn edges, higher in cavities"),
    }
    mat["metalness"] = {"base": round(metalness, 3), "variation": 0.03 if metalness > 0.2 else 0.0}
    bump = str(m.get("bump") or ("fine-grain" if texture > 0.2 else "none"))
    mat["normal"] = {
        "pattern": "derived-from-independent-height-field",
        "strength": round(0.08 + 0.35 * texture, 3),
        "scale": 24.0,
        "space": "tangent",
    }
    mat["bump"] = {"pattern": bump, "amplitude": round(0.004 + 0.02 * texture, 4) if bump != "none" else 0.0, "scale": 4.0}
    mat["ambientOcclusion"] = {
        "cavityStrength": 0.3,
        "contactShadowBias": 0.3,
        "notes": str(m.get("aoNotes") or "Darken seams, creases, contact points and recessed features."),
    }
    mat["wear"] = {
        "edgeWear": round(min(1.0, max(0.0, _num(m.get("edgeWear"), 0.05))), 3),
        "scratches": _strings(m.get("scratches")),
        "chips": _strings(m.get("chips")),
    }
    mat["dirt"] = {
        "amount": round(min(1.0, max(0.0, _num(m.get("dirt"), 0.0))), 3),
        "cavityBias": 0.3 if _num(m.get("dirt"), 0.0) > 0 else 0.0,
        "color": _hex(m.get("dirtColor"), "#2f2a22"),
    }
    overrides = []
    for i, item in enumerate(m.get("localOverrides") or []):
        if isinstance(item, dict):
            overrides.append(
                {
                    "id": _slug(item.get("id"), f"{mat_id}-override-{i}"),
                    "description": str(item.get("description") or ""),
                    "confidence": round(min(1.0, max(0.0, _num(item.get("confidence"), 0.6))), 3),
                }
            )
    mat["localOverrides"] = overrides
    for key in ("clearcoat", "clearcoatRoughness", "transmission", "ior", "thickness", "sheen", "iridescence", "opacity", "emissiveIntensity"):
        if key in m and isinstance(m[key], (int, float)) and not isinstance(m[key], bool):
            mat[key] = m[key]
    if isinstance(m.get("emissive"), str):
        mat["emissive"] = _hex(m["emissive"], "#000000")
    if m.get("doubleSided") is True:
        mat["doubleSided"] = True
    mat["notes"] = str(m.get("notes") or "Scalar PBR values inferred by the vision model from the reference image.")
    return mat


def _unit_scale(primitive: str, dims: dict[str, float], descriptor: dict[str, Any]) -> list[float]:
    """Geometry scale that makes a unit-authored primitive match the brief's real dimensions."""
    w, h, d = dims["width"], dims["height"], dims["depth"]
    if primitive in {"box", "sphere", "ellipsoid", "cylinder", "cone"}:
        return [w, h, d]
    if primitive == "plane-card":
        return [w, h, 1.0]
    if primitive == "capsule":  # buildWatertightCapsule(0.35, 0.7): 0.7 wide, 1.4 tall
        return [w / 0.7, h / 1.4, d / 0.7]
    if primitive == "torus":  # TorusGeometry(0.45, 0.45*ratio) lies in the XY plane
        ratio = _num(descriptor.get("torusTubeRatio"), 0.18)
        outer = 0.9 + 0.9 * ratio
        return [w / outer, h / outer, d / (0.9 * ratio) if ratio > 0 else 1.0]
    # lathe / extrude / tube / sweeps are authored in real model units.
    return [1.0, 1.0, 1.0]


def _expand_component(
    template: dict[str, Any],
    c: dict[str, Any],
    index: int,
    ids: set[str],
    material_ids: list[str],
    brief_by_id: dict[str, dict[str, Any]],
    view_ids: list[str],
) -> dict[str, Any]:
    comp_id = _slug(c.get("id"), f"part-{index}")
    primitive = str(c.get("primitive") or "box").strip().lower()
    primitive = PRIMITIVE_ALIASES.get(primitive, primitive)
    if primitive not in SUPPORTED:
        primitive = "box"
    parent = c.get("parent")
    parent = _slug(parent, "") if parent else None
    if parent == comp_id or (parent and parent not in ids):
        parent = None
    level = str(c.get("level") or ("macro" if parent is None else "meso")).lower()
    if level not in LEVELS:
        level = "meso"
    raw_dims = c.get("dimensions") if isinstance(c.get("dimensions"), dict) else {}
    dims = {
        "width": max(0.001, abs(_num(raw_dims.get("width"), 0.2))),
        "height": max(0.001, abs(_num(raw_dims.get("height"), 0.2))),
        "depth": max(0.001, abs(_num(raw_dims.get("depth"), 0.2))),
    }
    position = _vec3(c.get("position"), [0.0, 0.0, 0.0])
    rotation = _vec3(c.get("rotation"), [0.0, 0.0, 0.0])
    material = _slug(c.get("material"), material_ids[0]) if c.get("material") else material_ids[0]
    if material not in material_ids:
        material = material_ids[0]
    layers = [material] + [
        _slug(x, "") for x in (c.get("materialLayers") or []) if _slug(x, "") in material_ids and _slug(x, "") != material
    ]

    evidence = _refs(c.get("evidence") or c.get("evidenceRefs") or c.get("views"), view_ids)

    descriptor: dict[str, Any] = {
        "topologyIntent": str(c.get("shapeNotes") or f"{primitive} {c.get('name') or comp_id}"),
        "edgeTreatment": {
            "type": "rounded" if _num(c.get("bevelRadius"), 0) > 0 else "none",
            "bevelRadius": round(max(0.0, _num(c.get("bevelRadius"), 0.0)), 4),
            "segments": 4 if _num(c.get("bevelRadius"), 0) > 0 else 1,
        },
        "deformationStack": [],
        "uvStrategy": "generated procedural coordinates",
        "normalStrategy": "vertex normals from generated geometry",
    }
    if primitive == "torus":
        descriptor["torusTubeRatio"] = round(min(0.95, max(0.02, _num(c.get("torusTubeRatio"), 0.18))), 4)
    if primitive == "lathe":
        pts = [p for p in (c.get("latheProfile") or []) if isinstance(p, (list, tuple)) and len(p) == 2]
        if len(pts) < 2:
            pts = [[dims["width"] / 2, -dims["height"] / 2], [dims["width"] / 2, dims["height"] / 2]]
        descriptor["latheProfile"] = {"points": [[round(abs(_num(x, 0.1)), 5), round(_num(y, 0), 5)] for x, y in pts], "segments": 48}
    if primitive == "extrude":
        pts = [p for p in (c.get("extrudeProfile") or []) if isinstance(p, (list, tuple)) and len(p) == 2]
        if len(pts) < 3:
            hw, hh = dims["width"] / 2, dims["height"] / 2
            pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
        descriptor["profile2D"] = {
            "points": [[round(_num(x, 0), 5), round(_num(y, 0), 5)] for x, y in pts],
            "depth": round(dims["depth"], 5),
        }
    if primitive in {"tube", "tapered-sweep", "curve-sweep"}:
        pts = [p for p in (c.get("path") or []) if isinstance(p, (list, tuple)) and len(p) == 3]
        if len(pts) < 2:
            pts = [[0, -dims["height"] / 2, 0], [0, dims["height"] / 2, 0]]
        radii = c.get("radii") if isinstance(c.get("radii"), list) else None
        base_r = max(0.002, _num(c.get("radius"), dims["width"] / 2))
        if parent is not None or primitive == "tapered-sweep" or radii:
            # A parented tube would otherwise be rebuilt as a straight endpoint cylinder by the
            # attachment branch; a tapered sweep keeps the authored spine.
            primitive = "tapered-sweep"
            stations = []
            for i, p in enumerate(pts):
                r = _num(radii[i], base_r) if radii and i < len(radii) else base_r
                stations.append({"position": [round(_num(v, 0), 5) for v in p], "rx": round(r, 5), "rz": round(r, 5), "twist": 0.0})
            descriptor["taperedSweep"] = {"stations": stations, "radialSegments": 16, "capEnds": True}
        elif primitive == "curve-sweep":
            descriptor["curveSweep"] = {
                "spine": [[round(_num(v, 0), 5) for v in p] for p in pts],
                "crossSection": {"points": [[-base_r, -base_r], [base_r, -base_r], [base_r, base_r], [-base_r, base_r]]},
                "closed": False,
            }
        else:
            descriptor["tubePath"] = {"points": [[round(_num(v, 0), 5) for v in p] for p in pts], "radius": round(base_r, 5), "radialSegments": 16, "closed": bool(c.get("closed"))}
    subdivide = int(_num(c.get("subdivide"), 0))
    if subdivide in (1, 2) and primitive in {"box"}:
        descriptor["subdivide"] = {"iterations": subdivide, "scheme": "catmull-clark"}

    transform: dict[str, Any] = {"position": position, "rotation": rotation}
    attachment = None
    if parent is not None:
        contact = str(c.get("contactType") or "embedded-mount")
        if primitive in ENDPOINT_PRIMITIVES:
            # Endpoint-derived geometry: the limb runs along its local +Y, rotated by the brief's
            # rotation, centred on its position. The pivot rotation is folded into the endpoints.
            half = _rotate([0.0, dims["height"] / 2, 0.0], rotation)
            start = [round(p - h, 5) for p, h in zip(position, half)]
            end = [round(p + h, 5) for p, h in zip(position, half)]
            base_r = max(0.005, max(dims["width"], dims["depth"]) / 2)
            end_r = 0.003 if primitive == "cone" else base_r
            if isinstance(c.get("topRadius"), (int, float)):
                end_r = max(0.003, _num(c.get("topRadius"), end_r))
            attachment = {
                "parentId": parent,
                "parentSocket": f"{comp_id}Socket",
                "localStart": start,
                "localEnd": end,
                "baseRadius": round(base_r, 5),
                "endRadius": round(end_r, 5),
                "contactType": contact,
                "embedDepth": round(max(0.002, min(dims["width"], dims["height"]) * 0.05), 5),
                "gapTolerance": 0.004,
                "evidenceRefs": evidence,
            }
            transform["rotation"] = [0.0, 0.0, 0.0]
        else:
            half = _rotate([0.0, dims["height"] / 2, 0.0], rotation)
            attachment = {
                "parentId": parent,
                "parentSocket": f"{comp_id}Socket",
                "localStart": [round(p - h, 5) for p, h in zip(position, half)],
                "localEnd": [round(p + h, 5) for p, h in zip(position, half)],
                "contactType": contact,
                "embedDepth": round(max(0.002, min(dims["width"], dims["height"], dims["depth"]) * 0.05), 5),
                "gapTolerance": 0.004,
                "evidenceRefs": evidence,
            }
    transform["scale"] = [round(v, 5) for v in _unit_scale(primitive, dims, descriptor)]

    color = _hex(c.get("color"), "") if c.get("color") else ""
    mat_brief = brief_by_id.get(material, {})
    dominant = color or _hex(mat_brief.get("baseColor"))
    action = copy.deepcopy(template.get("actionProfile", {}))
    animation_role = str(c.get("animationRole") or ("root" if parent is None and index == 0 else "static"))
    action["animationRole"] = animation_role
    pivot = action.get("pivot") if isinstance(action.get("pivot"), dict) else {}
    pivot.update({"mode": "explicit" if c.get("pivot") else "center", "localPosition": _vec3(c.get("pivot"), [0.0, 0.0, 0.0]), "confidence": 0.6})
    action["pivot"] = pivot
    collider_type = {"sphere": "sphere", "ellipsoid": "sphere", "capsule": "capsule", "cylinder": "capsule"}.get(primitive, "box")
    action["collider"] = {"type": collider_type, "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False, "notes": "Coarse proxy from the component bounds."}
    action["sockets"] = []

    features = []
    for i, f in enumerate(c.get("features") or []):
        text = f.get("description") if isinstance(f, dict) else f
        if text:
            features.append(
                {
                    "id": _slug(f.get("id") if isinstance(f, dict) else "", f"{comp_id}-feature-{i}"),
                    "description": str(text),
                    "confidence": 0.65,
                    "level": level,
                    "evidence": _refs((f.get("evidence") if isinstance(f, dict) else None) or evidence, view_ids),
                }
            )

    component = {
        "id": comp_id,
        "name": str(c.get("name") or comp_id),
        "level": level,
        "role": str(c.get("role") or "part"),
        "importance": round(min(1.0, max(0.0, _num(c.get("importance"), 0.7 if level == "macro" else 0.5))), 3),
        "confidence": round(min(1.0, max(0.0, _num(c.get("confidence"), 0.6))), 3),
        "primitive": primitive,
        "topologyClass": "surface-relief" if level == "micro" and primitive == "plane-card" else "assembled-solid",
        "topologyRationale": str(c.get("shapeNotes") or "Rigid part assembled from a procedural primitive."),
        "geometryDescriptor": descriptor,
        "parent": parent,
        "attachment": attachment,
        "dimensions": {**{k: round(v, 5) for k, v in dims.items()}, "units": "relative", "confidence": 0.6},
        "transform": transform,
        "material": material,
        "materialLayers": layers,
        "colorMaterialRecipe": {
            "dominantAlbedo": _rgba(dominant),
            "secondaryAlbedo": _rgba(_shade(dominant, 0.85)),
            "materialClass": material_class(mat_brief),
            "materialClassConfidence": 0.6,
            "evidence": evidence,
            "samplingNotes": "Dominant albedo chosen by the vision model from the reference image.",
        },
        "actionProfile": action,
        "localFeatures": features,
        "evidenceRefs": evidence,
    }
    if color:
        component["colorOverride"] = color
    return component


def expand_brief(starter: dict[str, Any], brief: dict[str, Any], views: Any = None) -> dict[str, Any]:
    """`views` is the reference-image set the user uploaded:
    [{"angle": "front", "path": "/work/refs/....png", "name": "..."}, ...].
    Each one becomes a viewEvidence entry the spec's components can cite."""
    spec = copy.deepcopy(starter)
    spec["targetName"] = safe_name(spec.get("targetName"))
    psa = spec.setdefault("preSpecAssessment", {})

    # --- reference views ------------------------------------------------------------------
    uploaded = [v for v in (views or []) if isinstance(v, dict)] or [{"angle": "front"}]
    brief_views = {
        str(v.get("id")): v for v in (brief.get("views") or []) if isinstance(v, dict) and v.get("id")
    }
    view_entries: list[dict[str, Any]] = []
    for index, item in enumerate(uploaded):
        angle = str(item.get("angle") or "other").lower()
        angle = angle if angle in VIEW_ANGLES else "other"
        vid = view_id(index, angle)
        observed = brief_views.get(vid, {})
        view_entries.append(
            {
                "id": vid,
                "view": "primary" if index == 0 else angle,
                "angle": angle,
                "note": VIEW_ANGLES[angle],
                "sourceImage": str(item.get("path") or ""),
                "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
                "observations": _strings(observed.get("observations")) or (_strings(brief.get("observations")) if index == 0 else []),
                "confidence": round(min(1.0, max(0.0, _num(observed.get("confidence"), 0.65))), 3),
            }
        )
    spec["viewEvidence"] = view_entries
    view_ids = [v["id"] for v in view_entries]
    spec["referenceImages"] = [
        {"id": v["id"], "angle": v["angle"], "sourceImage": v["sourceImage"], "name": str(uploaded[i].get("name") or "")}
        for i, v in enumerate(view_entries)
    ]

    # --- identity & assessment ------------------------------------------------------------
    oc = brief.get("objectClass") if isinstance(brief.get("objectClass"), dict) else {}
    domain = str(oc.get("primaryDomain") or "object").lower()
    if domain not in {"object", "character", "hybrid"}:
        domain = "object"
    psa["objectClass"] = {
        "primaryType": str(oc.get("primaryType") or spec.get("targetName") or "object"),
        "primaryDomain": domain,
        "formLanguage": _strings(oc.get("formLanguage")) or ["geometric"],
        "structureKind": _strings(oc.get("structureKind")) or ["rigid-assembly"],
        "motionPotential": _strings(oc.get("motionPotential")) or ["static-display"],
        "materialFamilies": _strings(oc.get("materialFamilies")) or ["generic"],
        "notes": str(oc.get("notes") or "Classified by the vision model from the reference image."),
    }
    if brief.get("suitability") in {"pass", "conditional", "fail"}:
        spec["suitability"] = brief["suitability"]

    # --- materials ------------------------------------------------------------------------
    template_mat = (starter.get("materials") or [{}])[0]
    brief_mats = [m for m in (brief.get("materials") or []) if isinstance(m, dict)] or [{"id": "base", "baseColor": "#8a8a8a"}]
    materials = [_expand_material(template_mat, m, i) for i, m in enumerate(brief_mats)]
    seen: set[str] = set()
    for mat in materials:  # unique ids
        while mat["id"] in seen:
            mat["id"] += "-b"
        seen.add(mat["id"])
    spec["materials"] = materials
    material_ids = [m["id"] for m in materials]
    brief_by_id = {mat["id"]: bm for mat, bm in zip(materials, brief_mats)}

    # --- components -----------------------------------------------------------------------
    template_comp = (starter.get("componentTree") or [{}])[0]
    brief_comps = [c for c in (brief.get("components") or []) if isinstance(c, dict)]
    if not brief_comps:
        brief_comps = [{"id": "root", "primitive": "box", "dimensions": {"width": 1, "height": 1, "depth": 1}}]
    ids: set[str] = set()
    ordered: list[dict[str, Any]] = []
    for i, c in enumerate(brief_comps):
        cid = _slug(c.get("id"), f"part-{i}")
        while cid in ids:
            cid += "-b"
        c = {**c, "id": cid}
        ids.add(cid)
        ordered.append(c)
    # Parents must precede children for the generator's node lookup.
    by_id = {c["id"]: c for c in ordered}
    emitted: list[dict[str, Any]] = []
    done: set[str] = set()

    def visit(c: dict[str, Any], stack: tuple[str, ...] = ()) -> None:
        if c["id"] in done or c["id"] in stack:
            return
        p = _slug(c.get("parent"), "") if c.get("parent") else ""
        if p and p in by_id and p not in stack:
            visit(by_id[p], stack + (c["id"],))
        done.add(c["id"])
        emitted.append(c)

    for c in ordered:
        visit(c)
    spec["componentTree"] = [
        _expand_component(template_comp, c, i, ids, material_ids, brief_by_id, view_ids)
        for i, c in enumerate(emitted)
    ]

    # --- repetition systems ---------------------------------------------------------------
    reps = []
    for i, r in enumerate(brief.get("repetitions") or []):
        if not isinstance(r, dict):
            continue
        rep_id = _slug(r.get("id"), f"repetition-{i}")
        elements = [_slug(e, "") for e in (r.get("elementComponentIds") or []) if _slug(e, "") in ids]
        parent = _slug(r.get("parent"), "") if r.get("parent") else ""
        prim = PRIMITIVE_ALIASES.get(str(r.get("primitive") or "box").lower(), str(r.get("primitive") or "box").lower())
        rep_mat = _slug(r.get("material"), "")
        count = int(max(1, min(256, _num(r.get("count"), max(len(elements), 2)))))
        rep = {
            "id": rep_id,
            "kind": str(r.get("kind") or ("documented-array" if elements else "radial-array")),
            "count": count,
            "instances": count,
            "level": r.get("level") if r.get("level") in LEVELS else "micro",
            "target": elements[0] if elements else rep_id,
            "realization": str(r.get("notes") or ("Parts authored individually; documented as one system." if elements else "THREE.InstancedMesh ring around the parent centre.")),
            "evidence": _refs(r.get("evidence"), view_ids),
            "confidence": 0.6,
            "buildsGeometry": not elements,
        }
        if elements:
            rep["elementComponentIds"] = elements
        else:
            rep.update(
                {
                    "parent": parent if parent in ids else spec["componentTree"][0]["id"],
                    "primitive": prim if prim in SUPPORTED - {"lathe", "extrude", "tube", "tapered-sweep", "curve-sweep"} else "box",
                    "material": rep_mat if rep_mat in material_ids else material_ids[0],
                    "instanceScale": _vec3(r.get("instanceScale"), [0.05, 0.05, 0.05]),
                    "placement": {
                        "mode": "radial",
                        "axis": _vec3(r.get("axis"), [0.0, 1.0, 0.0]),
                        # The emitter places instances at radius * 0.5 from the parent centre.
                        "radius": round(2 * max(0.0, _num(r.get("radius"), 0.3)), 5),
                        "startAngleDeg": _num(r.get("startAngleDeg"), 0.0),
                    },
                }
            )
        reps.append(rep)
    spec["repetitionSystems"] = reps

    # --- complexity bookkeeping (derived from the authored tree) -------------------------
    counts = {lvl: sum(1 for c in spec["componentTree"] if c["level"] == lvl) for lvl in LEVELS}
    complexity = psa.setdefault("complexity", {})
    if brief.get("complexity") in {"simple", "moderate", "complex", "ultra-complex"}:
        complexity["tier"] = brief["complexity"]
    complexity["estimatedCounts"] = {
        "macroComponents": counts["macro"],
        "mesoComponents": counts["meso"],
        "microFeatureGroups": counts["micro"],
        "materialLayers": len(materials),
        "repetitionSystems": len(reps),
    }
    scores = complexity.get("scores") if isinstance(complexity.get("scores"), dict) else {}
    brief_scores = brief.get("complexityScores") if isinstance(brief.get("complexityScores"), dict) else {}
    for key in list(scores.keys()) or [
        "silhouetteComplexity", "componentCount", "hierarchyDepth", "repetitionDensity",
        "materialLayerCount", "localDetailDensity", "occlusionRisk", "actionReadinessNeed",
    ]:
        scores[key] = int(min(3, max(0, _num(brief_scores.get(key), 1))))
    complexity["scores"] = scores
    complexity["reasoning"] = _strings(brief.get("complexityReasoning")) or [
        f"{counts['macro']} macro, {counts['meso']} meso and {counts['micro']} micro components authored from the reference."
    ]

    # --- detail inventory -----------------------------------------------------------------
    inventory = psa.setdefault("detailInventory", {})
    details = []
    for i, d in enumerate(brief.get("details") or []):
        if not isinstance(d, dict):
            continue
        comp_ref = _slug(d.get("componentRef"), "") if d.get("componentRef") else ""
        mat_ref = _slug(d.get("materialRef"), "") if d.get("materialRef") else ""
        maps_to = str(d.get("mapsTo") or comp_ref or mat_ref or spec["componentTree"][0]["id"])
        details.append(
            {
                "id": _slug(d.get("id"), f"detail-{i}"),
                "description": str(d.get("description") or ""),
                "priority": d.get("priority") if d.get("priority") in {"critical", "important", "minor"} else "important",
                "componentRef": comp_ref or spec["componentTree"][0]["id"],
                "materialRef": mat_ref or material_ids[0],
                "evidenceRef": _refs(d.get("evidence") or d.get("evidenceRef"), view_ids)[0],
                "confidence": round(min(1.0, max(0.0, _num(d.get("confidence"), 0.65))), 3),
                "realization": "unreported",
                "kind": detail_kind(d.get("kind")),
                "mapsTo": {"ref": maps_to},
            }
        )
    inventory["details"] = details
    inventory["scanMethod"] = "vision-model-whole-frame"
    inventory["note"] = "Enumerated by the vision LLM from the whole reference frame (img2threejs Studio)."

    # --- review targets, silhouette, evidence ----------------------------------------------
    frts = []
    for i, t in enumerate(brief.get("featureReviewTargets") or []):
        if not isinstance(t, dict):
            continue
        tier = t.get("tier") if t.get("tier") in {"critical", "important", "minor"} else "important"
        refs = [_slug(r, "") for r in (t.get("componentRefs") or []) if _slug(r, "") in ids] or [spec["componentTree"][0]["id"]]
        passes = [p for p in _strings(t.get("passIds")) if p in spec.get("sculptPipeline", {}).get("passOrder", [])] or ["blockout"]
        frts.append(
            {
                "id": _slug(t.get("id"), f"feature-{i}"),
                "name": str(t.get("name") or t.get("id") or f"feature {i}"),
                "tier": tier,
                "passIds": passes,
                "minimumScore": 0.8 if tier == "critical" else 0.7,
                "mustPass": tier == "critical",
                "componentRefs": refs,
                "evidenceRefs": _refs(t.get("evidence") or t.get("evidenceRefs"), view_ids),
            }
        )
    if frts:
        spec["featureReviewTargets"] = frts

    sil = brief.get("silhouette") if isinstance(brief.get("silhouette"), dict) else {}
    spec["silhouette"] = {
        "boundingShape": str(sil.get("boundingShape") or ""),
        "aspectRatios": _strings(sil.get("aspectRatios")),
        "symmetry": str(sil.get("symmetry") or ""),
        "dominantCurves": _strings(sil.get("dominantCurves")),
        "negativeSpaces": _strings(sil.get("negativeSpaces")),
        "landmarks": _strings(sil.get("landmarks")),
    }
    cam = brief.get("referenceCamera") if isinstance(brief.get("referenceCamera"), dict) else {}
    rc = spec.setdefault("referenceCamera", {})
    rc.setdefault("orientation", {})
    rc["orientation"]["yaw"] = _num(cam.get("yaw"), 25.0)
    rc["orientation"]["pitch"] = _num(cam.get("pitch"), 15.0)
    rc["fovDegrees"] = _num(cam.get("fovDegrees"), 35.0)
    rc["note"] = "Estimated by the vision model (not solved with solve_camera_pose.py); used as a review-render hint."

    # --- lighting -------------------------------------------------------------------------
    light = brief.get("lighting") if isinstance(brief.get("lighting"), dict) else {}
    entries = []
    for role in ("key", "fill", "rim", "environment"):
        item = light.get(role)
        if isinstance(item, str):
            item = {"direction": item}
        if not isinstance(item, dict):
            item = {}
        entries.append(
            {
                "role": role,
                "direction": str(item.get("direction") or {"key": "upper-left, ~45deg elevation", "fill": "front-right, low", "rim": "behind, above", "environment": "soft studio IBL"}[role]),
                "colorTemp": str(item.get("colorTemp") or "neutral"),
                "intensity": str(item.get("intensity") or ("moderate" if role == "key" else "low")),
                "evidence": [view_ids[0]],
            }
        )
    entries[-1]["note"] = str(light.get("notes") or "ACES filmic tone mapping, exposure ~1.0, neutral background, soft contact shadow on the ground plane.")
    spec["lightingFromPhoto"] = entries

    # --- material pass: reference PBR extraction is not run in the browser ---------------
    ldt = spec.setdefault("lookDevTargets", {}).setdefault("materialPass", {})
    extraction = ldt.setdefault("referencePbrExtraction", {})
    extraction["requiredWhenSourceImagePresent"] = False
    extraction["skipReason"] = (
        "img2threejs Studio runs in the browser without extract_pbr_evidence.py map baking; scalar PBR "
        "values (albedo palette, roughness, metalness, clearcoat) are estimated by the vision model from "
        "the reference and flagged as approximate in risks."
    )

    spec["assumptions"] = _strings(brief.get("assumptions")) or ["Hidden sides are inferred from symmetry and typical construction."]
    spec["risks"] = _strings(brief.get("risks")) + [
        "Scalar PBR values are estimated by a vision LLM from a single image, not extracted from pixels."
    ]
    psa["unknownsToResolveBeforeImplementation"] = _strings(brief.get("unknowns"))
    return spec


# ---------------------------------------------------------------------------------------------
# Validation and code generation (original modules)
# ---------------------------------------------------------------------------------------------


def _forge_paths() -> None:
    for sub in ("forge", "forge/_shared", "forge/stage2_spec", "forge/stage3_build"):
        p = str(FORGE_ROOT / sub)
        if p not in sys.path:
            sys.path.insert(0, p)


def check(spec: dict[str, Any], pass_id: str = "optimization-pass") -> dict[str, Any]:
    """Same gate `generate_threejs_factory.py` applies before writing any code."""
    _forge_paths()
    gen = importlib.import_module("generate_threejs_factory")
    orch = importlib.import_module("orchestrate_passes")
    errors, warnings, strict = gen.strict_quality_failures(spec)
    try:
        gaps = orch.pass_specific_gaps(spec, pass_id)
    except Exception as exc:  # noqa: BLE001
        gaps = [f"pass gap check failed: {exc}"]
    return {"errors": list(errors), "warnings": list(warnings), "strictFailures": list(strict), "passGaps": list(gaps)}


def validate_cli(spec: dict[str, Any]) -> dict[str, Any]:
    """Run the validator CLI too, so the log shows the canonical command and output."""
    WORK.mkdir(parents=True, exist_ok=True)
    path = WORK / "object-sculpt-spec.json"
    path.write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
    return run_script("forge/stage2_spec/validate_sculpt_spec.py", [str(path), "--strict-quality"])


def generate(spec: dict[str, Any], pass_id: str = "optimization-pass") -> dict[str, Any]:
    """Emit the Three.js factory with the original generator.

    The CLI only emits the pass unlocked by browser-review evidence. The Studio preview asks the
    same `generate()` for the full component set (all levels) and labels the result as an
    unreviewed preview; strict-quality has already passed at this point.
    """
    _forge_paths()
    gen = importlib.import_module("generate_threejs_factory")
    WORK.mkdir(parents=True, exist_ok=True)
    path = WORK / "object-sculpt-spec.json"
    path.write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
    code = gen.generate(spec, pass_id)
    (WORK / "createModel.ts").write_text(code, encoding="utf-8")
    fn = None
    for line in code.splitlines():
        if line.startswith("export function create") and line.split("(")[0].endswith("Model"):
            fn = line.split("export function ")[1].split("(")[0]
            break
    base = fn[len("create"):-len("Model")] if fn else "Object"
    return {
        "code": code,
        "passId": pass_id,
        "exports": {
            "model": fn,
            "lights": f"create{base}LookDevLights",
            "environment": f"create{base}Environment",
            "frame": f"frame{base}Camera",
            "renderer": f"configure{base}Renderer",
            "controls": f"create{base}InspectControls",
        },
        "command": f"python3 forge/stage3_build/generate_threejs_factory.py object-sculpt-spec.json --out createModel.ts  # studio preview: generate(spec, {pass_id!r})",
    }


def append_review(spec: dict[str, Any], review: dict[str, Any]) -> dict[str, Any]:
    """Record a vision review with the original stage4 script (`append_review.py`)."""
    WORK.mkdir(parents=True, exist_ok=True)
    path = WORK / "object-sculpt-spec.json"
    path.write_text(json.dumps(spec, indent=2, ensure_ascii=False), encoding="utf-8")
    action = review.get("action") if review.get("action") in {"continue", "refine-code", "refine-spec", "request-input", "stop"} else "refine-spec"
    score = min(1.0, max(0.0, _num(review.get("score"), 0.5)))
    args = [
        str(path),
        "--pass-id", str(review.get("passId") or "blockout"),
        "--fidelity", f"{score:.3f}",
        "--action", action,
        "--summary", str(review.get("summary") or "Vision review")[:400],
        "--ai-vision-score", f"{score:.3f}",
        "--camera-view", "reference-3q",
        "--in-place",
    ]
    if review.get("mapStrippedRender"):
        args += ["--map-stripped-render", str(review["mapStrippedRender"])]
    feature_reviews = []
    for item in review.get("featureReviews") or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            entry = {"id": item["id"], "score": min(1.0, max(0.0, _num(item.get("score"), 0.0)))}
            if item.get("notes"):
                entry["notes"] = str(item["notes"])[:300]
            feature_reviews.append(entry)
    if feature_reviews:
        args += ["--feature-reviews-json", json.dumps(feature_reviews)]
    if review.get("reviewViewpoints"):
        args += ["--review-viewpoints-json", json.dumps(_strings(review["reviewViewpoints"]))]
    if review.get("matched"):
        args += ["--matched", "; ".join(_strings(review.get("matched")))[:1500]]
    if review.get("mismatches"):
        args += ["--mismatches", "; ".join(_strings(review.get("mismatches")))[:1500]]
    if review.get("specFixes"):
        args += ["--spec-fixes", "; ".join(_strings(review.get("specFixes")))[:1500]]
    if isinstance(review.get("layerScores"), dict):
        layer = {k: min(1.0, max(0.0, _num(v, 0.5))) for k, v in review["layerScores"].items()}
        args += ["--layer-scores-json", json.dumps(layer)]
    if review.get("renderScreenshot"):
        args += ["--render-screenshot", str(review["renderScreenshot"])]
    if review.get("referenceScreenshot"):
        args += ["--reference-screenshot", str(review["referenceScreenshot"])]
    if review.get("comparisonImage"):
        args += ["--comparison-image", str(review["comparisonImage"])]
    step = run_script("forge/stage4_review/append_review.py", args)
    try:
        updated = _load_json(path)
    except Exception:  # noqa: BLE001
        updated = spec
    return {"step": step, "spec": updated}


def comparison_sheet(reference: str, render: str, out: str) -> dict[str, Any]:
    """Side-by-side reference/render sheet with the original stage4 script."""
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    step = run_script(
        "forge/stage4_review/make_comparison_sheet.py",
        ["--reference", reference, "--render", render, "--out", out, "--panel-width", "560", "--panel-height", "560", "--json"],
    )
    step["ok"] = step["exitCode"] == 0 and Path(out).exists()
    return step


def review_targets(spec: dict[str, Any], pass_id: str) -> list[dict[str, Any]]:
    """featureReviewTargets the append_review gate will check for this pass."""
    out = []
    for target in spec.get("featureReviewTargets") or []:
        if isinstance(target, dict) and pass_id in (target.get("passIds") or []):
            out.append({k: target.get(k) for k in ("id", "name", "tier", "minimumScore", "mustPass", "componentRefs")})
    return out


def required_layers(spec: dict[str, Any]) -> list[str]:
    acceptance = (spec.get("selfCorrectLoop") or {}).get("visualAcceptance") or {}
    layers = acceptance.get("requiredLayerScores")
    return [str(x) for x in layers] if isinstance(layers, list) else []


def read_source(relpath: str) -> str:
    return (FORGE_ROOT / relpath).read_text(encoding="utf-8")


def api(action: str, payload_json: str) -> str:
    """Single JSON entry point used from JavaScript."""
    payload = json.loads(payload_json) if payload_json else {}
    if action == "probe":
        result = probe(payload["image"])
    elif action == "starter":
        result = starter_spec(payload["name"], payload["image"], payload.get("complexity", "moderate"))
    elif action == "expand":
        result = {"spec": expand_brief(payload["starter"], payload["brief"], payload.get("views"))}
    elif action == "check":
        result = check(payload["spec"])
        result["cli"] = validate_cli(payload["spec"])
    elif action == "generate":
        result = generate(payload["spec"], payload.get("passId", "optimization-pass"))
    elif action == "review":
        result = append_review(payload["spec"], payload["review"])
    elif action == "sheet":
        result = comparison_sheet(payload["reference"], payload["render"], payload["out"])
    elif action == "reviewContext":
        spec = payload["spec"]
        result = {
            "targets": review_targets(spec, payload["passId"]),
            "layers": required_layers(spec),
            "threshold": ((spec.get("selfCorrectLoop") or {}).get("visualAcceptance") or {}).get("threshold", 0.7),
        }
    elif action == "source":
        result = {"source": read_source(payload["path"])}
    else:
        raise ValueError(f"unknown action {action}")
    return json.dumps(result, ensure_ascii=False)
