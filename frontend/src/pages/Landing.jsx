import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/* Landing — the first screen at the root of the app. A plain black stage with a
   dithered wave rising from the bottom in the Colonel brand gradient
   (#0748EE → #F115F8), the "Agent.Accountant" wordmark, and one way in.

   The wave is the signature: a grid of dots whose size tracks a moving field of
   layered sine waves, so it reads as an animated, print-textured swell rather
   than a smooth gradient. Everything else stays quiet. Self-contained canvas —
   no libraries, no external assets. Respects prefers-reduced-motion (renders one
   still frame). */

const BLUE = [7, 72, 238];    // #0748EE
const PURPLE = [241, 21, 248]; // #F115F8

function DitherWave() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let width = 0;
    let height = 0;
    const GAP = 12; // px between dot centers

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Wave field: 1 at a dot fully "in" the swell, 0 above it. The crest line
    // sweeps across x and drifts over time; higher up the page = sparser dots.
    const field = (x, y, t) => {
      const nx = x / width;
      const crest = 0.62
        + 0.14 * Math.sin(nx * 6.28 + t * 0.6)
        + 0.06 * Math.sin(nx * 12.9 - t * 0.9);
      const ny = y / height;
      // Distance below the crest, softened into a 0..1 band.
      const d = (ny - crest) / 0.42;
      return Math.max(0, Math.min(1, d + 0.15 * Math.sin(nx * 20 + t)));
    };

    const draw = (tMs) => {
      const t = tMs / 1000;
      ctx.clearRect(0, 0, width, height);
      for (let y = 0; y < height; y += GAP) {
        for (let x = 0; x < width; x += GAP) {
          const v = field(x, y, t);
          if (v <= 0.02) continue;
          // Blue at the crest, purple deep in the swell.
          const r = Math.round(BLUE[0] + (PURPLE[0] - BLUE[0]) * v);
          const g = Math.round(BLUE[1] + (PURPLE[1] - BLUE[1]) * v);
          const b = Math.round(BLUE[2] + (PURPLE[2] - BLUE[2]) * v);
          const radius = 0.5 + v * 2.3; // dot grows with depth → dithered gradient
          ctx.beginPath();
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.arc(x, y, radius, 0, 6.2832);
          ctx.fill();
        }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    resize();
    if (reduce) draw(0);
    else raf = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

export default function Landing() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const enter = () => {
    if (!user) { navigate('/login'); return; }
    if (user.role === 'admin') navigate('/admin');
    else if (user.role === 'developer') navigate('/feedback');
    else if (user.role === 'accountant') navigate('/brands');
    else navigate('/dashboard');
  };

  return (
    <div
      style={{
        position: 'relative', minHeight: '100vh', width: '100%', overflow: 'hidden',
        background: '#000', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <DitherWave />

      {/* Content sits above the wave */}
      <div style={{ position: 'relative', textAlign: 'center', zIndex: 1 }}>
        <h1
          style={{
            margin: 0, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.05,
            fontSize: 'clamp(40px, 8vw, 96px)',
            background: 'linear-gradient(135deg, #0748EE, #F115F8)',
            WebkitBackgroundClip: 'text', backgroundClip: 'text',
            WebkitTextFillColor: 'transparent', color: 'transparent',
          }}
        >
          Agent.Accountant
        </h1>
        <p style={{ marginTop: 14, color: 'rgba(255,255,255,0.55)', fontSize: 'clamp(13px, 1.6vw, 16px)', letterSpacing: '0.01em' }}>
          Precision accounting automation for modern CA firms.
        </p>

        <button
          type="button"
          onClick={enter}
          data-testid="landing-login-button"
          style={{
            marginTop: 34, padding: '13px 40px', borderRadius: 9999, border: 'none',
            fontSize: 15, fontWeight: 700, cursor: 'pointer', color: '#fff',
            background: 'linear-gradient(135deg, #0748EE, #F115F8)',
            boxShadow: '0 8px 30px rgba(7,72,238,0.35)',
          }}
        >
          {user ? 'Enter app' : 'Login'}
        </button>
      </div>
    </div>
  );
}
