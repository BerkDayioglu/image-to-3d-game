// Prompts that drive the vision LLM through the img2threejs stages.
// The LLM never writes Three.js code: it writes a compact SculptBrief (stage 2 authoring),
// which studio_pipeline.expand_brief() turns into a full ObjectSculptSpec for the original
// validate_sculpt_spec.py --strict-quality gate and generate_threejs_factory.py codegen.

export const BRIEF_SCHEMA = `
SculptBrief JSON schema (all lengths in model units, Y is up, +Z faces the viewer, rotations in radians, XYZ Euler):
{
  "targetName": string,                        // short English name of the subject, e.g. "Red Ceramic Mug"
  "suitability": "pass" | "conditional" | "fail",
  "suitabilityNote": string,
  "complexity": "simple" | "moderate" | "complex" | "ultra-complex",
  "complexityScores": { "silhouetteComplexity":0-3, "componentCount":0-3, "hierarchyDepth":0-3, "repetitionDensity":0-3,
                        "materialLayerCount":0-3, "localDetailDensity":0-3, "occlusionRisk":0-3, "actionReadinessNeed":0-3 },
  "complexityReasoning": [string],
  "objectClass": { "primaryType": string, "primaryDomain": "object" | "character" | "hybrid",
                   "formLanguage": [string], "structureKind": [string], "motionPotential": [string],
                   "materialFamilies": [string], "notes": string },
  "silhouette": { "boundingShape": string, "aspectRatios": [string], "symmetry": string,
                  "dominantCurves": [string], "negativeSpaces": [string], "landmarks": [string] },
  "observations": [string],                    // what you actually see: colours, finishes, parts, proportions
  "referenceCamera": { "yaw": deg, "pitch": deg, "fovDegrees": deg },   // camera of the photo relative to the object front
  "materials": [ {
      "id": camelCase, "name": string,
      "materialClass": "metal"|"plastic"|"wood"|"fabric"|"skin"|"glass"|"ceramic"|"rubber"|"stone"|"unknown",
      "finish": string,                         // e.g. "glossy-ceramic", "brushed-aluminium", "matte-plastic"
      "baseColor": "#rrggbb", "secondary": ["#rrggbb", "#rrggbb"],   // sampled from the photo, sRGB
      "roughness": 0-1, "metalness": 0-1, "textureStrength": 0-1,      // 0 = clean/smooth, 1 = heavy grain/noise
      "pattern": "uniform"|"mottled"|"streaked"|"speckled"|"banded",
      "bump": "none"|"fine-grain"|"brushed-linear"|"wood-grain"|"fabric-weave"|"hammered",
      "edgeWear": 0-1, "dirt": 0-1,
      "clearcoat": 0-1, "clearcoatRoughness": 0-1, "transmission": 0-1, "ior": number, "thickness": number,
      "opacity": 0-1, "emissive": "#rrggbb", "emissiveIntensity": number, "sheen": 0-1, "doubleSided": boolean,
      "localOverrides": [ { "id": camelCase, "description": string, "confidence": 0-1 } ],  // local colour zones, prints, wear
      "samplingNotes": string
  } ],
  "components": [ {
      "id": camelCase (unique), "name": string,
      "level": "macro" | "meso" | "micro",       // macro = main masses, meso = secondary parts, micro = small details
      "role": string,                           // body, lid, handle, leg, wheel, button, screen, trim, decal, ...
      "parent": null | id,                      // id of an EARLIER component; null only for root masses
      "primitive": "box"|"sphere"|"ellipsoid"|"cylinder"|"cone"|"capsule"|"torus"|"lathe"|"extrude"|"tube"|"tapered-sweep"|"plane-card",
      "dimensions": { "width": x-size, "height": y-size, "depth": z-size },
      "position": [x, y, z],                    // centre of the part; for children: offset from the PARENT's centre in the parent's rotated frame (parent size does NOT scale it)
      "rotation": [rx, ry, rz],
      "material": materialId, "materialLayers": [materialId],
      "color": "#rrggbb" (optional per-part albedo override),
      "importance": 0-1, "confidence": 0-1,
      "features": [ { "id": camelCase, "description": string } ],   // micro details carried by this part (seams, screws, prints, grooves)
      "shapeNotes": string,
      // primitive-specific (only when used):
      "torusTubeRatio": 0.02-0.9,               // torus: tube radius / ring radius
      "latheProfile": [[radius, y], ...],        // lathe: real-unit profile revolved around the part's local Y axis, ordered bottom->top; include inner wall points for hollow vessels
      "extrudeProfile": [[x, y], ...],           // extrude: real-unit closed polygon in local XY, extruded from z=0 to z=depth
      "path": [[x, y, z], ...], "radius": r, "radii": [r0, r1, ...],   // tube / tapered-sweep: real-unit spine in local space, per-point radius
      "topRadius": r,                           // cylinder/cone children: top radius (taper)
      "subdivide": 0 | 1 | 2,                   // box only: Catmull-Clark smoothing for soft organic blobs
      "animationRole": "static" | "root" | "hinge" | "rotor" | "slider" | "wheel" | "button" | "idle-sway",
      "pivot": [x, y, z],                       // local pivot for animatable parts (e.g. hinge line)
      "contactType": "embedded-mount" | "flush-mount" | "pivot-hinge" | "inset-socket" | "through-embed" | "welded"
  } ],
  "repetitions": [ {                            // repeated elements (bolts on a ring, spokes, studs)
      "id": camelCase, "elementComponentIds": [ids] // EITHER list parts you already authored individually,
      // OR let the system instance them in a ring around the parent's centre:
      "parent": id, "primitive": "box"|"sphere"|"cylinder"|"cone", "material": materialId, "count": int,
      "radius": ring radius, "axis": [x, y, z], "instanceScale": [sx, sy, sz], "level": "meso"|"micro"
  } ],
  "details": [ {                                // detailInventory: identity-defining small details
      "id": kebab-case, "description": string, "priority": "critical" | "important" | "minor",
      "kind": "gloss"|"bevel"|"fastener"|"linework"|"contour"|"seam"|"stitch"|"stain"|"scratch"|"chip"|"decal"|"emissive"|"hole"|"groove"|"ridge",
      "componentRef": componentId, "materialRef": materialId,
      "mapsTo": componentId | featureId | "materialId/overrideId",   // must name a real component, feature or material override
      "confidence": 0-1
  } ],
  "featureReviewTargets": [ { "id": kebab-case, "name": string, "tier": "critical" | "important",
      "passIds": ["blockout"|"structural-pass"|"form-refinement"|"material-pass"|"surface-pass"|"lighting-pass"|"interaction-pass"],
      "componentRefs": [componentId] } ],
  "lighting": { "key": {"direction": string, "colorTemp": string, "intensity": string},
                "fill": {...}, "rim": {...}, "environment": {...}, "notes": string },
  "assumptions": [string], "risks": [string], "unknowns": [string]
}`;

export const PRIMITIVE_GUIDE = `
How each primitive is built (the generator bakes the size into the geometry; you give real sizes):
- box: width x height x depth, centred on position.
- sphere / ellipsoid: diameters along X/Y/Z.
- cylinder: width = depth = diameter, height along local Y. Use rotation to lay it down (e.g. [0,0,1.5708] makes it lie along X).
- cone: base diameter = width, apex at local +Y.
- capsule: width = diameter, height = total length along local Y (rounded ends are included for root parts; parented capsules become straight tapered rods).
- torus: ring lies in the local XY plane, hole axis = local Z. width/height = OUTER diameter, depth = tube thickness. A wheel facing sideways (axle along X) needs rotation [0, 1.5708, 0]. A horizontal ring (like a mug rim) needs rotation [1.5708, 0, 0].
- lathe: give latheProfile in real units; dimensions are informational. Best for bottles, vases, cups, lamp shades, knobs, bowls, bullets, chess pieces.
- extrude: give extrudeProfile (real units, XY plane) — best for flat cut-out shapes: blades, logos, brackets, flat panels with an outline, gun receivers seen from the side.
- tube / tapered-sweep: give path points (local) and radius / radii — best for handles, cables, pipes, tails, horns, bent rods, limbs.
- plane-card: flat width x height card facing +Z — use for decals, screens, labels, printed graphics.
Children with cylinder/cone/capsule are rebuilt from their endpoints (position ± height/2 along the rotated Y axis) — keep those consistent.
`;

export const TIER_TABLE = `
Minimum spec depth enforced by --strict-quality per complexity tier (counts come from YOUR brief):
| tier          | macro comps | meso comps | micro features (sum of all components' "features") | materials | repetitions | details |
| simple        | 1           | 0          | 0                                                  | 1         | 0           | 3       |
| moderate      | 2           | 3          | 2                                                  | 2         | 0           | 6       |
| complex       | 3           | 8          | 5                                                  | 3         | 1           | 10      |
| ultra-complex | 5           | 16         | 8                                                  | 4         | 2           | 16      |
Pick the tier from what the image really shows, then MEET its minimums (you may exceed them).`;

export function authoringSystemPrompt() {
  return `You are the vision stage of img2threejs — a pipeline that rebuilds the object in a reference image as a code-only, procedural Three.js model (reconstruction-by-code, not photogrammetry). You do not write code. You inspect the image and author a SculptBrief: a precise, measured decomposition of the subject into procedural primitives, materials and details. Deterministic img2threejs scripts expand it into an ObjectSculptSpec, run the strict-quality gate and generate the Three.js factory.

Work in this order (img2threejs core promise):
1. Validate: is the subject a single, readable 3D target? Set suitability.
2. Assess: object class, complexity tier (see table), identity-defining features.
3. Detail inventory first: enumerate identity-defining small details (gloss, bevels, fasteners, seams, printed linework, grooves, stains/wear) before decomposing. Every detail must map to a real component, feature or material override — drop any detail you cannot place instead of faking it.
4. Decompose: macro masses -> meso parts -> micro features. Hold proportions and silhouette to the reference: measure relative sizes from the pixels (e.g. "handle is 55% of body height"). Choose the primitive that matches each part's true form (lathe for turned/revolved forms, extrude for flat outlines, tapered-sweep for bent or tapering parts) — not boxes everywhere.
5. Materials: derive colours from the reference pixels (sRGB hex), separate finish classes (matte vs gloss vs metal), set roughness/metalness honestly; flag colours or regions you are unsure of.
6. State what a single image cannot show (hidden sides) in assumptions/unknowns instead of faking confidence.

Coordinate conventions: Y up, object front faces +Z, the whole object should span roughly 1–2 units on its largest axis, and it should rest on y = 0 (bottom of the lowest root part at y ≈ 0). Root parts use world positions; child positions are offsets from the parent's centre in the parent's (rotated) frame.
${PRIMITIVE_GUIDE}
${TIER_TABLE}
${BRIEF_SCHEMA}

Output rules: reply with ONE json code block containing the SculptBrief and nothing else. All ids unique. Parents must be defined before children. Use only the enums listed. Typical good briefs have 8–30 components.`;
}

export function authoringUserPrompt({ hint, probe }) {
  const parts = [
    'Reference image attached. Author the SculptBrief for the main subject.',
  ];
  if (hint) parts.push(`User note about the subject: "${hint}"`);
  if (probe) parts.push(`Technical probe (probe_image.py): ${probe.width}x${probe.height}px ${probe.type}, suitability ${probe.technicalSuitability}${probe.warnings?.length ? ', warnings: ' + probe.warnings.join('; ') : ''}.`);
  return parts.join('\n');
}

export function fixPrompt(check) {
  const lines = [
    ...check.errors.map((e) => `error: ${e}`),
    ...check.strictFailures.map((e) => e.replace(/^strict quality failure: /, 'strict: ')),
    ...check.passGaps.map((e) => `pass-gap: ${e}`),
  ];
  return `The img2threejs gate (validate_sculpt_spec.py --strict-quality) rejected the spec expanded from your SculptBrief:
${lines.map((l) => '- ' + l).join('\n')}

Fix every item at its source in the brief (add real components/features/details that exist in the image, correct enums, add missing links). Do not pad with invented parts that are not in the image — if the tier is too high for what is visible, lower "complexity" instead. Reply with the COMPLETE corrected SculptBrief as one json code block.`;
}

export function reviewSystemPrompt() {
  return `You are the Divine Eye review stage of img2threejs. You inspect a side-by-side comparison sheet (reference photo left, render of the current procedural Three.js reconstruction right) plus extra orbit views, score the current build pass, and correct the SculptBrief that produced it.
Rules (img2threejs self-correction loop):
- Score honestly from 0 to 1. A pass may only "continue" when the global score AND every required layer score meet the threshold AND every critical feature meets its own minimum. Fail the pass when an identity-defining feature is wrong even if the global look is close.
- Pixel similarity is not the authority; judge semantic identity: silhouette, proportions, part structure, materials, details.
- Judge the pass you are told. Earlier passes are about form (blockout/structure); later ones about materials, surface and lighting.
- When you choose "refine-spec", fix the causes in the brief: wrong proportions, missing or wrong-primitive parts, misplaced children, colours/finishes. Keep everything that already matches.
${PRIMITIVE_GUIDE}
${BRIEF_SCHEMA}

Reply with ONE json code block:
{
  "score": 0-1,
  "layerScores": { <every required layer name>: 0-1 },
  "featureReviews": [ { "id": <feature target id>, "score": 0-1, "notes": string } ],   // one per listed feature target
  "summary": string (one sentence),
  "matched": [string],
  "mismatches": [string],            // concrete: "handle is 30% too small and sits too low"
  "specFixes": [string],             // what you changed in the brief
  "action": "continue" | "refine-spec",
  "brief": { ...the COMPLETE corrected SculptBrief... }   // required when action is refine-spec
}`;
}

export function reviewUserPrompt({ brief, passId, threshold, layers, targets, images }) {
  return `Pass under review: "${passId}". Acceptance threshold: ${threshold}.
Required layer scores: ${layers.join(', ')}.
Feature targets for this pass (score each by id):
${targets.length ? targets.map((t) => `- ${t.id} (${t.tier}, min ${t.minimumScore}): ${t.name}`).join('\n') : '- (none for this pass)'}

Images, in order: ${images.map((label, i) => `image ${i + 1} = ${label}`).join('; ')}.

Current SculptBrief:
\`\`\`json
${JSON.stringify(brief)}
\`\`\`
Review the match and reply with the JSON described in the system prompt.`;
}
