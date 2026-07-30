import React, { useRef, useEffect } from 'react';

/* AgentShowcase — "The Ring" (Showcase 15 style): the agent cards ORBIT slowly
   around a CENTER CONTROL PANEL of sliders (Speed / Spread / Zoom). The sliders
   live-tune the motion; the card passing the front grows to full detail while the
   others ease down. Pure 2D DOM + CSS transforms via requestAnimationFrame — no
   libraries. Respects prefers-reduced-motion (static grid). */

const BLUE = '#0748EE';
const PURPLE = '#F115F8';
const GRAD = `linear-gradient(135deg, ${BLUE}, ${PURPLE})`;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// The firm's MAJOR agent groups — each with its own accent colour.
const AGENTS = [
  { icon: '📂', name: 'GST Reconciliation', category: 'Reconcile', color: '#4F7DF7',
    desc: 'GSTR-2B, 2A, 3B and GSTR-1 reconciled against your books — every return.' },
  { icon: '🧾', name: 'Invoice Processing', category: 'Payables', color: '#8B5CF6',
    desc: 'Reads, extracts and posts vendor invoices — TDS and GST captured.' },
  { icon: '🛒', name: 'Marketplace & Sales', category: 'Sales MIS', color: '#F59E0B',
    desc: 'Amazon, Flipkart, Myntra, Nykaa, Zepto — sales MIS, consolidated.' },
  { icon: '📦', name: 'Order Cycle', category: 'Order-to-cash', color: '#A855F7',
    desc: 'Order-to-cash tracked end to end: sales, courier COD and SRN.' },
  { icon: '⚡', name: 'Receivables', category: 'Collections', color: '#EC4899',
    desc: 'Marketplace receivables reconciled — PO through payment advice.' },
  { icon: '🏦', name: 'Bank & Finance', category: 'Banking', color: '#10B981',
    desc: 'Universal bank statement classified and reconciled to Tally.' },
  { icon: '🧮', name: 'E-Invoicing', category: 'IRN', color: '#38BDF8',
    desc: 'Generates and reconciles e-invoice IRNs against your books.' },
  { icon: '📒', name: 'Journal Entry', category: 'GSTR-3B', color: '#2DD4BF',
    desc: 'Turns a GSTR-3B into ready-to-post Tally journal entries.' },
  { icon: '✅', name: 'Compliance Tracker', category: 'Statutory', color: '#22C55E',
    desc: 'Every filing and due date tracked — per brand, per month.' },
  { icon: '📊', name: 'CFO Dashboards', category: 'Analytics', color: '#6366F1',
    desc: 'Live MIS and CFO analytics across all your brands.' },
  { icon: '📗', name: 'Zoho Books Sync', category: 'Ledgers', color: '#F97316',
    desc: 'Mirrors Zoho Books into one master ledger, kept in sync.' },
  { icon: '🎥', name: 'Meetings & Notes', category: 'Fireflies', color: '#E879F9',
    desc: 'Records, transcribes and summarises client meetings automatically.' },
  { icon: '🏷️', name: 'Bank Classifier', category: 'Learning', color: '#06B6D4',
    desc: 'Learns your ledger map and classifies bank narrations across brands.' },
  { icon: '🤖', name: 'Colonel AI', category: 'Copilot', color: '#A78BFA',
    desc: 'Ask anything about a brand — answered from its own data.' },
];

const N = AGENTS.length;
const RX = 460;            // ellipse horizontal radius
const RY = 360;            // ellipse vertical radius
const CARD_SCALE = 0.46;   // resting card size
const FEATURE_DEG = 180;   // cards grow as they pass the BOTTOM-front of the ring
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function AgentCard({ agent }) {
  const c = agent.color || BLUE;
  const cRGB = rgb(c);
  const grad = `linear-gradient(140deg, ${c}, ${PURPLE})`;
  return (
    <div style={{
      position: 'relative', width: 300, height: 418, borderRadius: 26, padding: 1.2,
      background: `linear-gradient(150deg, rgba(${cRGB},0.9), rgba(255,255,255,0.08) 55%, rgba(${cRGB},0.35))`,
      boxShadow: `0 26px 70px rgba(0,0,0,0.6), 0 0 40px rgba(${cRGB},0.10)`,
    }}>
      <div style={{
        position: 'relative', width: '100%', height: '100%', borderRadius: 25,
        background: `radial-gradient(130% 80% at 50% -8%, rgba(${cRGB},0.16), #101018 40%, #0A0A10 100%)`,
        overflow: 'hidden', display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: '34px 26px 24px',
      }}>
        <div aria-hidden="true" style={{
          position: 'absolute', inset: 0, opacity: 0.05, pointerEvents: 'none',
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.9) 1px, transparent 1.4px)',
          backgroundSize: '15px 15px',
          maskImage: 'radial-gradient(120% 70% at 100% 0%, #000, transparent 62%)',
          WebkitMaskImage: 'radial-gradient(120% 70% at 100% 0%, #000, transparent 62%)',
        }} />
        <div style={{
          width: 68, height: 68, borderRadius: 20, padding: 1.4, background: grad,
          boxShadow: `0 0 30px rgba(${cRGB},0.55)`, position: 'relative', zIndex: 1,
        }}>
          <div style={{
            width: '100%', height: '100%', borderRadius: 19,
            background: `radial-gradient(circle at 50% 30%, rgba(${cRGB},0.45), #0B0B12 72%)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30,
          }}>
            <span aria-hidden="true">{agent.icon}</span>
          </div>
        </div>
        <span style={{
          marginTop: 22, position: 'relative', zIndex: 1, fontFamily: MONO,
          fontSize: 10.5, letterSpacing: '0.18em', textTransform: 'uppercase',
          color: c, padding: '5px 13px', borderRadius: 999,
          border: `1px solid rgba(${cRGB},0.4)`, background: `rgba(${cRGB},0.10)`,
        }}>{agent.category}</span>
        <h3 style={{
          margin: '16px 0 0', color: '#fff', fontWeight: 800, fontSize: 25,
          letterSpacing: '-0.02em', lineHeight: 1.15, textAlign: 'center', position: 'relative', zIndex: 1,
        }}>{agent.name}</h3>
        <p style={{
          margin: '12px 0 0', color: '#A6ADC0', fontSize: 13.5, lineHeight: 1.55,
          textAlign: 'center', maxWidth: 240, position: 'relative', zIndex: 1,
        }}>{agent.desc}</p>
        <div style={{ marginTop: 'auto', width: '100%', position: 'relative', zIndex: 1 }}>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '0 0 16px' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 700, color: c }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
              Live
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Run agent →</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* One labelled slider inside the centre panel. */
function Slider({ left, right, trackRef, knobRef }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginBottom: 8,
        fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#8A90A6',
      }}>
        <span>{left}</span><span>{right}</span>
      </div>
      <div ref={trackRef} style={{
        position: 'relative', height: 6, borderRadius: 999,
        background: 'rgba(255,255,255,0.12)', cursor: 'grab', touchAction: 'none',
      }}>
        <div ref={knobRef} style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 18, height: 18, borderRadius: '50%', background: GRAD,
          boxShadow: '0 0 12px rgba(124,92,255,0.7)',
        }} />
      </div>
    </div>
  );
}

export default function AgentShowcase() {
  const cardRefs = useRef([]);
  const params = useRef({ speed: 0.5, spread: 0.5, zoom: 0.55, angle: 0 });
  const tracks = { speed: useRef(null), spread: useRef(null), zoom: useRef(null) };
  const knobs = { speed: useRef(null), spread: useRef(null), zoom: useRef(null) };
  const reduce = typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Animation loop.
  useEffect(() => {
    if (reduce) return undefined;
    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(50, now - last); last = now;
      const p = params.current;
      const degPerMs = lerp(360 / 95000, 360 / 22000, p.speed); // Slow ↔ Fast
      p.angle += degPerMs * dt;
      const radMul = lerp(0.82, 1.18, p.spread);                // Tight ↔ Wide
      const zoomAmt = lerp(0, 1.15, p.zoom);                    // Subtle ↔ Zoom
      for (let i = 0; i < N; i++) {
        const el = cardRefs.current[i];
        if (!el) continue;
        const angleDeg = (i / N) * 360 + p.angle;
        const rad = angleDeg * Math.PI / 180;
        const x = Math.sin(rad) * RX * radMul;
        const y = -Math.cos(rad) * RY * radMul;
        const norm = ((angleDeg % 360) + 360) % 360;
        const dF = Math.abs(((norm - FEATURE_DEG + 540) % 360) - 180); // deg from feature
        const near = smooth(clamp01(1 - dF / 55));
        const scale = CARD_SCALE * (1 + zoomAmt * near) * (1 - 0.22 * zoomAmt * (1 - near));
        el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`;
        el.style.opacity = (1 - 0.4 * zoomAmt * (1 - near)).toFixed(3);
        el.style.zIndex = String(1 + Math.round(near * 20));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  // Wire the three sliders (drag → params + knob position).
  useEffect(() => {
    if (reduce) return undefined;
    const cleanups = [];
    const wire = (key) => {
      const track = tracks[key].current;
      const knob = knobs[key].current;
      if (!track || !knob) return;
      knob.style.left = `${params.current[key] * 100}%`;
      let dragging = false;
      const setX = (clientX) => {
        const r = track.getBoundingClientRect();
        const v = clamp01((clientX - r.left) / r.width);
        params.current[key] = v;
        knob.style.left = `${v * 100}%`;
      };
      const cx = (e) => (e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0));
      const down = (e) => { dragging = true; setX(cx(e)); e.preventDefault(); };
      const move = (e) => { if (dragging) setX(cx(e)); };
      const up = () => { dragging = false; };
      track.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      cleanups.push(() => {
        track.removeEventListener('pointerdown', down);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      });
    };
    ['speed', 'spread', 'zoom'].forEach(wire);
    return () => cleanups.forEach((fn) => fn());
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
      <div style={{ position: 'relative', width: '100%', height: '88vh', minHeight: 780, overflow: 'hidden' }}>
        {/* Orbiting agent cards */}
        <div style={{ position: 'absolute', left: '50%', top: '50%', width: 0, height: 0 }}>
          {AGENTS.map((agent, i) => (
            <div
              key={agent.name}
              ref={(el) => { cardRefs.current[i] = el; }}
              style={{
                position: 'absolute', left: 0, top: 0, width: 300, height: 418,
                transform: `translate(-50%, -50%) scale(${CARD_SCALE})`,
                willChange: 'transform, opacity', zIndex: 1,
              }}
            >
              <AgentCard agent={agent} />
            </div>
          ))}
        </div>

        {/* Centre control panel — the cards orbit around this */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(320px, 40%)', zIndex: 40, padding: '22px 24px 12px', borderRadius: 22,
          background: 'rgba(11,11,18,0.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
        }}>
          <div style={{
            fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.24em', textTransform: 'uppercase',
            color: '#6B7180', marginBottom: 18, textAlign: 'center',
          }}>Tune the ring</div>
          <Slider left="Slow" right="Fast" trackRef={tracks.speed} knobRef={knobs.speed} />
          <Slider left="Tight" right="Wide" trackRef={tracks.spread} knobRef={knobs.spread} />
          <Slider left="Subtle" right="Zoom" trackRef={tracks.zoom} knobRef={knobs.zoom} />
        </div>
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
        fontFamily: MONO, fontSize: 12, letterSpacing: '0.22em', textTransform: 'uppercase',
        color: '#6B7180', marginBottom: 14,
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
