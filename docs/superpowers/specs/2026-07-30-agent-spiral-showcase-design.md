# Agent Spiral Showcase — Design (v2, real 3D)

**Date:** 2026-07-30
**Where:** below the hero on the Landing page (`/`), colonel-automation local :3000. LOCAL only.
**Goal:** Reproduce the **exact motion** of the reference **"Showcase 16 — The Spiral"** (craftwork.design) with our agent cards — no compromise.

---

## 1. What the reference REALLY is (decoded frame-by-frame, 2026-07-30)

It is a **pre-rendered 13-second 3D video** (a Jitter motion export — a real 3D camera, rendered offline). I stepped the actual MP4:

| t | What's on screen |
|---|---|
| 1s | A **stacked spiral column** — all cards stacked in depth, tilted, the front one low/large (camera near, viewing the ring roughly EDGE-ON). |
| 5s | The **spread ring** — the same cards arranged around a circle in 3D, seen roughly FACE-ON, one hero nearest the camera. |
| 8s | Back to the **stacked column** (edge-on again). |

**Conclusion:** the cards live on a **fixed 3D ring/helix**, and a **single camera orbits around it continuously** (with a gentle dolly in/out). Edge-on to the ring → you see the stacked column; face-on → you see the spread circle. It is **one smooth continuous orbit**, NOT a series of per-card zoom pulses.

## 2. Why our previous attempts failed

We built it with hand-tuned **CSS `transform` pulses**. CSS `perspective` fakes depth per-element but there is **no real camera**, so:
- "Zoom into each card" had to be faked with a per-card scale/translateZ **pulse** → the **bouncing** feel (in–out–in–out) that isn't in the video.
- No true depth sorting → overlapping cards became a muddy wall.
CSS 3D is the wrong tool for a **continuous 3D camera orbit with real depth**. The reference's smoothness comes from a real 3D render.

## 3. Approach — a real 3D scene (React Three Fiber / Three.js)

Build an actual 3D scene so we have a **real camera** to orbit, exactly like the reference.

- **Library:** `three` + `@react-three/fiber` (React renderer for Three.js) + `@react-three/drei` (helpers). These are the industry-standard, well-maintained tools for exactly this (Codrops, threejsresources all use them). New deps — approved by the user ("use any open-source").
- **Cards as textured planes (true depth):** each agent card is rasterized **once** from the existing React `AgentCard` DOM to a PNG via `html-to-image`, then mapped onto a Three.js plane (`meshBasicMaterial` + `CanvasTexture`). This keeps the **exact Stitch card design** AND gives real WebGL depth/occlusion (so the stacked-column view sorts correctly — the thing Html-overlays can't do reliably).
- **Ring/helix layout:** `N` planes at `angle_i = i·(2π/N)` on radius `R`, each with a small vertical offset (`y_i`) so it reads as a gentle helix, each plane rotated to face the ring's axis (billboarded outward).
- **Camera rig (the motion):** a custom rig orbits the ring center — `azimuth(t)` advances continuously (the spin); `radius(t)` and `height(t)` ease between a **near** pose (card fills frame — the showcase) and a **far** pose (whole ring visible), on a **slow single cycle** synced to the orbit so it reads as one flowing spiral, never a bounce. `camera.lookAt` tracks the ring centre (or eases toward the current front card at the near pose). Cubic easing throughout.
- **Loop:** `azimuth` wraps over the loop period; the whole path is periodic → seamless infinite loop. Target ~10–13s per loop to match the reference cadence.
- **Showcase one-by-one:** because the near-pose of the dolly lands on the card currently at the front of the orbit, each agent is featured in turn.

## 4. Fidelity plan (how we hit "exact")

- Rebuild the camera path from the decoded timeline: near-pose at the column moments (~t=1, 8, …), far-pose at the ring moment (~t=5). Keep the **same in/out cadence** as the 13s reference.
- Tune against the reference screenshots (`ref_t1/t5/t8.jpg`) and the live video, side by side, until the silhouette of the motion matches at the key beats.
- Verify deterministically by scrubbing the loop clock (`window.__scrubT`) to the key beats and screenshotting, before letting it run.

## 5. Card (unchanged — already approved)

The **Stitch "Luminous Dark Fintech"** `AgentCard` (300×418 deep-glass `#0B0B12`, blue→purple gradient border+glow, icon badge, mono category tag, bold name, gray description, ACCURACY stat, "Run agent →"), with the real 12 flagship agents. Rasterized to a texture for the 3D scene; the DOM component stays the single source of the design.

## 6. Structure & files

- `frontend/src/pages/AgentShowcase.jsx` — rewritten: a `<Canvas>` (R3F) scene with the ring of textured card-planes + the orbiting camera rig; `<Header/>` stays as normal DOM above the canvas. Reduced-motion / no-WebGL → the existing static grid of `AgentCard`s (no canvas).
- New small helper to rasterize `AgentCard`s to textures (html-to-image) at mount, with a graceful fallback.
- Deps added to `frontend/package.json`: `three`, `@react-three/fiber`, `@react-three/drei`, `html-to-image`.

## 7. Risks / honest caveats

- **It will be extremely close, but a hand-built real-time scene is still not a byte-for-byte copy of an offline render.** The camera *path* and card *look* will match; micro-timing/lighting nuances of the Jitter render won't be identical. This is the closest achievable in-app without shipping a pre-rendered video.
- **Bundle size:** three+fiber+drei ≈ 150–600 KB gzipped added to the landing bundle. Acceptable for a marketing hero; can be lazy-loaded/code-split so it only loads for the Landing page.
- **Rasterizing DOM→texture** must run after fonts/emoji load; we rasterize on mount and swap textures in when ready (cards show a plain plane for a beat, then the full design).

## 8. Guardrails

LOCAL 3000 only, no AWS/GitHub push. Additive; back up before editing shared files. Commit once the motion is approved. Lazy-load the 3D bundle so the rest of the app is unaffected.

---

## Decision needed before building

This changes the technique from CSS to a real 3D scene and **adds dependencies** (`three`, `@react-three/fiber`, `@react-three/drei`, `html-to-image`). That's the honest path to the exact motion. **Approve installing these + building this, or say if you'd rather I keep it dependency-free (which caps how close we can get).**
