import React, { useRef, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import * as htmlToImage from 'html-to-image';

/* AgentShowcase — the "Showcase 16 — The Spiral" motion as a real 3D scene.

   The reference is a hand-keyframed 3D render (Jitter) exported to video: a ring
   of cards, camera orbiting, cards leaning back ("sleeping"), each featured one at
   a time. To reproduce it we render each of our Stitch cards to an IMAGE and map
   it onto a real double-sided 3D plane — so depth-sorting and perspective are real
   (no mirrored HTML backs, no muddy overlap).

   Choreography (one loop): open on the intro "Agent.Accountant / Agents" card →
   the agent cards emerge staggered out of it, leaning back, spiralling into a ring
   → the camera rises and orbits, featuring each agent one-by-one → everything
   reverses (ring collapses back into the intro card) → loop.

   `window.__scrubT` (0..1) freezes the loop for tuning. Reduced motion → static grid. */

const BLUE = '#0748EE';
const PURPLE = '#F115F8';
const GRAD = `linear-gradient(135deg, ${BLUE}, ${PURPLE})`;

const AGENTS = [
  { icon: '🏦', name: 'Bank Reco', category: 'Bank & Finance', accuracy: '99.8%',
    desc: 'Matches your Tally daybook against the universal bank output, line by line.' },
  { icon: '📂', name: 'GSTR-2B vs Books', category: 'GST Reconciliation', accuracy: '99.5%',
    desc: 'Reconciles GSTR-2B against your purchase and debit-note registers, invoice by invoice.' },
  { icon: '🌍', name: 'Universal Bank Statement', category: 'Bank & Finance', accuracy: '100%',
    desc: 'Classifies every bank narration to the right ledger — across any bank format.' },
  { icon: '🛒', name: 'Amazon MTR Consolidator', category: 'Marketplace MIS', accuracy: '99.8%',
    desc: 'Consolidates Amazon MTR B2C and B2B into one clean monthly MIS workbook.' },
  { icon: '🧾', name: 'E-Invoice Reco', category: 'GST Reconciliation', accuracy: '99.6%',
    desc: 'Cross-checks e-invoice IRNs against your books and flags every gap.' },
  { icon: '⚡', name: 'Zepto Receivables', category: 'Marketplace MIS', accuracy: null,
    desc: 'Reconciles Zepto receivables from a Drive folder — PO through payment advice.' },
  { icon: '📊', name: 'GSTR-1 vs Books', category: 'GST Reconciliation', accuracy: '99.3%',
    desc: 'Ties your sales register to the GSTR-1 filed and surfaces every difference.' },
  { icon: '📦', name: 'Receivable Cycle', category: 'Order Cycle', accuracy: null,
    desc: 'Tracks the whole order-to-cash cycle: sales, courier COD and SRN in one view.' },
  { icon: '📒', name: 'GSTR-3B Tally Entry', category: 'Journal Entry', accuracy: '99.9%',
    desc: 'Turns a GSTR-3B into ready-to-post Tally journal entries automatically.' },
  { icon: '📄', name: 'PDF → Bank Statement', category: 'Bank & Finance', accuracy: null,
    desc: 'Extracts a clean statement from any bank PDF — columns detected on their own.' },
  { icon: '🔀', name: 'GSTR-3B vs GSTR-2B', category: 'GST Reconciliation', accuracy: '99.4%',
    desc: 'Reconciles your GSTR-3B summary against GSTR-2B to catch ITC mismatches.' },
  { icon: '🧮', name: 'GSTR-2A / 2B / Books', category: 'GST Reconciliation', accuracy: '99.5%',
    desc: 'A three-way match across GSTR-2A, 2B and your books in a single pass.' },
];

const N = AGENTS.length;
const TAU = Math.PI * 2;
const R = 7.0;              // ring radius (world units) — sized so the full circle fits the frame
const LOOP = 15;           // seconds per loop
const STAGGER = 0.6;       // how much later the last card emerges vs the first
const CARD_TILT = -1.0;    // radians (~ -57 deg): cards lean back / "sleep"
const SPIN_OUT = TAU * 0.55; // how far each card winds around as it spirals out
const SPIN_SELF = 1.4;      // self-spin (rad) that unwinds as the card settles flat
const TURNS = 1.0;          // one clean ring (helix turns)
const COIL_H = 1.2;         // gentle vertical depth
const SLOT_COUNT = 12;      // one card per agent — a clean, readable ring
const CARD_W = 2.25, CARD_H = CARD_W * 418 / 300; // small cards, kept consistent
const INTRO_W = 3.2, INTRO_H = INTRO_W * 430 / 320;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const seg = (t, a, b) => clamp01((t - a) / (b - a));

/* ── DOM cards (rasterised to textures) ─────────────────────────────────────── */
function AgentCard({ agent }) {
  return (
    <div style={{
      position: 'relative', width: 300, height: 418, borderRadius: 26, padding: 1, background: GRAD,
    }}>
      <div style={{
        position: 'relative', width: '100%', height: '100%', borderRadius: 25,
        background: 'linear-gradient(180deg, #15151F 0%, #0B0B12 62%)',
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: '32px 26px 24px',
      }}>
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'radial-gradient(120% 60% at 50% -10%, rgba(120,90,255,0.20), transparent 60%)',
        }} />
        <div style={{
          width: 66, height: 66, borderRadius: '50%', padding: 1, background: GRAD,
          boxShadow: '0 0 24px rgba(7,72,238,0.35)', position: 'relative', zIndex: 1,
        }}>
          <div style={{
            width: '100%', height: '100%', borderRadius: '50%',
            background: 'radial-gradient(circle at 50% 35%, rgba(120,90,255,0.35), #0B0B12 70%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30,
          }}>
            <span aria-hidden="true">{agent.icon}</span>
          </div>
        </div>
        <span style={{
          marginTop: 22, position: 'relative', zIndex: 1,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase',
          color: '#9AA0B4', padding: '5px 12px', borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)',
        }}>{agent.category}</span>
        <h3 style={{
          margin: '16px 0 0', color: '#fff', fontWeight: 800, fontSize: 25,
          letterSpacing: '-0.02em', lineHeight: 1.15, textAlign: 'center', position: 'relative', zIndex: 1,
        }}>{agent.name}</h3>
        <p style={{
          margin: '12px 0 0', color: '#9AA0B4', fontSize: 13.5, lineHeight: 1.55,
          textAlign: 'center', maxWidth: 240, position: 'relative', zIndex: 1,
        }}>{agent.desc}</p>
        <div style={{ marginTop: 'auto', width: '100%', position: 'relative', zIndex: 1 }}>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '0 0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div>
              <div style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 9.5, letterSpacing: '0.14em', color: '#6B7180', textTransform: 'uppercase',
              }}>{agent.accuracy ? 'Accuracy' : 'Status'}</div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.01em', color: '#7C5CFF' }}>
                {agent.accuracy || 'Live'}
              </div>
            </div>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Run agent →</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function IntroCard() {
  return (
    <div style={{
      position: 'relative', width: 320, height: 430, borderRadius: 28, padding: 1.5, background: GRAD,
    }}>
      <div style={{
        width: '100%', height: '100%', borderRadius: 27,
        background: 'radial-gradient(120% 90% at 50% 0%, #191426 0%, #0B0B12 60%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '40px 30px', textAlign: 'center',
      }}>
        <div style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
          letterSpacing: '0.28em', textTransform: 'uppercase', color: '#9AA0B4', marginBottom: 18,
        }}>The agents</div>
        <div style={{ fontWeight: 800, fontSize: 34, lineHeight: 1.05, letterSpacing: '-0.02em', color: '#C9B8FF' }}>
          Agent.<br />Accountant
        </div>
        <div style={{ marginTop: 20, fontSize: 14, color: '#9AA0B4', lineHeight: 1.5, maxWidth: 240 }}>
          Twelve agents. One firm. Every reconciliation, automated.
        </div>
      </div>
    </div>
  );
}

/* ── 3D scene ───────────────────────────────────────────────────────────────── */
const h = React.createElement; // three intrinsics via createElement (skips the visual-edits babel plugin)
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

function Spiral({ textures }) {
  const slots = useRef([]);   // agent plane meshes
  const mats = useRef([]);    // agent materials (opacity)
  const introRef = useRef(null);
  const introMat = useRef(null);

  useFrame((state) => {
    const scrub = (typeof window !== 'undefined') ? window.__scrubT : undefined;
    const t = (scrub != null) ? scrub : (state.clock.getElapsedTime() % LOOP) / LOOP;

    const build = smooth(seg(t, 0.06, 0.30)) * (1 - smooth(seg(t, 0.80, 0.98)));
    const featT = smooth(seg(t, 0.30, 0.80));
    const zoomP = smooth(seg(t, 0.40, 0.80));   // dolly IN during the feature pass
    const roll = t * TAU;                        // the whole coil rolls once per loop (the "reel")

    // Camera: side view (see the coil's layers) → rises toward top (the circle) →
    // dips + dollies in to zoom into the rolling coil. Only a gentle drift in azimuth,
    // because the COIL itself is what rolls.
    const el = lerp(0.16, 0.92, build) - zoomP * 0.4;
    const dist = lerp(7.5, 17, build) - zoomP * 8;
    const az = featT * TAU * 0.25;
    state.camera.position.set(
      Math.sin(az) * Math.cos(el) * dist,
      Math.sin(el) * dist,
      Math.cos(az) * Math.cos(el) * dist,
    );
    state.camera.lookAt(0, 0, 0);

    // Intro card billboards to the camera at the centre; fades as the coil forms.
    if (introRef.current) {
      introRef.current.position.set(0, 0, 0.15);
      introRef.current.quaternion.copy(state.camera.quaternion);
      const s = lerp(1, 0.6, build);
      introRef.current.scale.set(s, s, s);
      if (introMat.current) introMat.current.opacity = 1 - smooth(seg(build, 0.12, 0.55));
    }

    // Agent cards: a dense helix (SLOT_COUNT cards over TURNS turns) that rolls like a
    // reel. Each card spirals out of the stack as it emerges, then the coil keeps rolling.
    for (let i = 0; i < SLOT_COUNT; i++) {
      const g = slots.current[i];
      if (!g) continue;
      const f = i / SLOT_COUNT;
      const bi = clamp01(build * (1 + STAGGER) - f * STAGGER);
      const be = smooth(bi);
      const aBase = f * TAU * TURNS + roll;      // helix position + continuous roll
      const yT = (f - 0.5) * COIL_H;
      const ang = aBase - (1 - be) * SPIN_OUT;   // wind out of the stack as it emerges
      const rad = R * be;
      g.position.set(Math.sin(ang) * rad, yT * be, Math.cos(ang) * rad);
      g.rotation.order = 'YXZ';
      g.rotation.set(CARD_TILT * be, ang, (1 - be) * SPIN_SELF);
      const sc = lerp(0.4, 1, be);
      g.scale.set(sc, sc, sc);
      const m = mats.current[i];
      if (m) {
        g.getWorldQuaternion(_q); _n.set(0, 0, 1).applyQuaternion(_q);
        g.getWorldPosition(_p); _v.copy(state.camera.position).sub(_p).normalize();
        const facing = clamp01((_n.dot(_v) + 0.1) / 0.5);
        m.opacity = be * facing;
      }
    }
  });

  return h('group', null, [
    h('mesh', { key: '__intro', ref: (el) => { introRef.current = el; } },
      h('planeGeometry', { args: [INTRO_W, INTRO_H] }),
      h('meshBasicMaterial', {
        ref: (el) => { introMat.current = el; },
        map: textures.intro, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false,
      }),
    ),
    ...Array.from({ length: SLOT_COUNT }).map((_, i) =>
      h('mesh', { key: `slot-${i}`, ref: (el) => { slots.current[i] = el; } },
        h('planeGeometry', { args: [CARD_W, CARD_H] }),
        h('meshBasicMaterial', {
          ref: (el) => { mats.current[i] = el; },
          map: textures.agents[i % N], transparent: true, side: THREE.FrontSide, toneMapped: false, depthWrite: false,
        }),
      ),
    ),
  ]);
}

/* ── Rasteriser + wrapper ───────────────────────────────────────────────────── */
async function nodeToTexture(node) {
  const dataUrl = await htmlToImage.toPng(node, { pixelRatio: 2, skipFonts: true });
  const img = await new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl;
  });
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export default function AgentShowcase() {
  const reduce = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [textures, setTextures] = useState(null);
  const introHidden = useRef(null);
  const agentHidden = useRef([]);

  useEffect(() => {
    if (reduce) return undefined;
    let cancelled = false;
    (async () => {
      try {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        await new Promise((r) => setTimeout(r, 250)); // let emoji/gradients settle
        const intro = await nodeToTexture(introHidden.current);
        const agents = [];
        for (let i = 0; i < AGENTS.length; i++) {
          // eslint-disable-next-line no-await-in-loop
          agents.push(await nodeToTexture(agentHidden.current[i]));
        }
        if (!cancelled) setTextures({ intro, agents });
      } catch (e) { console.error('[AgentShowcase] rasterise failed', e); }
    })();
    return () => { cancelled = true; };
  }, [reduce]);

  if (reduce) {
    return (
      <section style={sectionStyle}>
        <Header />
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 300px))',
          gap: 24, justifyContent: 'center', maxWidth: 1000, padding: '0 24px 80px',
        }}>
          {AGENTS.slice(0, 6).map((a) => <AgentCard key={a.name} agent={a} />)}
        </div>
      </section>
    );
  }

  return (
    <section style={sectionStyle}>
      <Header />

      {/* Hidden DOM used only to rasterise the cards to textures. */}
      <div aria-hidden="true" style={{ position: 'absolute', left: -99999, top: 0, opacity: 0.001, pointerEvents: 'none' }}>
        <div ref={introHidden}><IntroCard /></div>
        {AGENTS.map((a, i) => (
          <div key={a.name} ref={(el) => { agentHidden.current[i] = el; }}><AgentCard agent={a} /></div>
        ))}
      </div>

      <div style={{ position: 'relative', width: '100%', height: '92vh', minHeight: 760 }}>
        <Canvas
          camera={{ fov: 38, near: 0.1, far: 100, position: [0, 2, 12] }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          style={{ background: 'transparent' }}
        >
          {textures ? <Spiral textures={textures} /> : null}
        </Canvas>
      </div>
    </section>
  );
}

const sectionStyle = {
  position: 'relative', minHeight: '100vh', width: '100%', background: '#000',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
  overflow: 'hidden',
};

function Header() {
  return (
    <div style={{ textAlign: 'center', padding: '60px 24px 8px', position: 'relative', zIndex: 10 }}>
      <div style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
        letterSpacing: '0.22em', textTransform: 'uppercase', color: '#6B7180', marginBottom: 14,
      }}>The agents at work</div>
      <h2 style={{
        margin: 0, fontWeight: 800, letterSpacing: '-0.02em', color: '#fff',
        fontSize: 'clamp(28px, 4.5vw, 46px)', lineHeight: 1.1,
      }}>
        One firm.{' '}
        <span style={{
          background: GRAD, WebkitBackgroundClip: 'text', backgroundClip: 'text',
          WebkitTextFillColor: 'transparent', color: 'transparent',
        }}>Every reconciliation, automated.</span>
      </h2>
    </div>
  );
}
