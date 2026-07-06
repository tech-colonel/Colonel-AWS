import React from 'react';

/* Real, self-contained brand logos (inline SVG — CSP-safe, no external requests).
   Used by the Integrations page so connectors show their actual marks, not a
   generic placeholder. Unknown types fall back to a neutral plug glyph. */

export default function BrandLogo({ type, size = 28 }) {
  const s = { width: size, height: size, display: 'block' };
  switch (type) {
    case 'google':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="Google">
          <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
          <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
          <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34A21.98 21.98 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" />
          <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
        </svg>
      );
    case 'gmail':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="Gmail">
          <path fill="#4285F4" d="M42 40h-6V22l-12 9-12-9v18H6a2 2 0 0 1-2-2V14l20 15 20-15v24a2 2 0 0 1-2 2z" />
          <path fill="#34A853" d="M4 38V14l10 7.5V40H6a2 2 0 0 1-2-2z" />
          <path fill="#FBBC05" d="M44 38a2 2 0 0 1-2 2h-8V21.5L44 14z" />
          <path fill="#EA4335" d="M4 14l20 15 20-15v-1.6A2.4 2.4 0 0 0 41.6 10H6.4A2.4 2.4 0 0 0 4 12.4z" />
        </svg>
      );
    case 'clickup':
      return (
        <svg viewBox="0 0 36 36" style={s} aria-label="ClickUp">
          <defs>
            <linearGradient id="cuA" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#8930FD" /><stop offset="1" stopColor="#49CCF9" />
            </linearGradient>
            <linearGradient id="cuB" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#FF02F0" /><stop offset="1" stopColor="#FFC800" />
            </linearGradient>
          </defs>
          <path fill="url(#cuA)" d="M3 26.2l5.7-4.4c3 3.9 6.2 5.7 9.6 5.7 3.3 0 6.4-1.8 9.3-5.6l5.8 4.5C34.6 31.6 29.6 35 23.3 35 17 35 11.9 31.7 7.9 26.2z" transform="translate(-1.3 -1)" />
          <path fill="url(#cuB)" d="M18.3 9.6L9 17.7l-4.7-5.4L18.3 0l14 12.3-4.7 5.4z" transform="translate(-1.3 1)" />
        </svg>
      );
    case 'slack':
      return (
        <svg viewBox="0 0 122.8 122.8" style={s} aria-label="Slack">
          <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A" />
          <path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
          <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0" />
          <path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
          <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D" />
          <path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
          <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E" />
          <path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
        </svg>
      );
    case 'quickbooks':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="QuickBooks">
          <circle cx="24" cy="24" r="22" fill="#2CA01C" />
          <path fill="#fff" d="M19.5 13.5a10.5 10.5 0 0 0 0 21h2.2V30h-2.2a6 6 0 0 1 0-12h.3v17.5h4.5V13.5h-4.8z" opacity="0.95" />
          <path fill="#fff" d="M28.5 34.5a10.5 10.5 0 0 0 0-21h-2.2V18h2.2a6 6 0 0 1 0 12h-.3V12.5h-4.5V34.5h4.8z" />
        </svg>
      );
    case 'zoho_books':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="Zoho Books">
          <rect x="6" y="7" width="30" height="34" rx="3" fill="#2A6DF4" />
          <rect x="11" y="7" width="31" height="34" rx="3" fill="#1A4FB0" />
          <rect x="16" y="14" width="20" height="2.6" rx="1.3" fill="#fff" opacity="0.9" />
          <rect x="16" y="20" width="20" height="2.6" rx="1.3" fill="#fff" opacity="0.7" />
          <rect x="16" y="26" width="13" height="2.6" rx="1.3" fill="#fff" opacity="0.55" />
          <text x="29" y="37" fontFamily="Arial, sans-serif" fontSize="9" fontWeight="700" fill="#FDB916" textAnchor="middle">₹</text>
        </svg>
      );
    case 'tally':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="Tally">
          <rect x="3" y="3" width="42" height="42" rx="9" fill="#C8102E" />
          <text x="24" y="33" fontFamily="Georgia, 'Times New Roman', serif" fontSize="26" fontWeight="700" fill="#fff" textAnchor="middle">T</text>
        </svg>
      );
    case 'fireflies':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="Fireflies.ai">
          <defs>
            <linearGradient id="ffG" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#F23E9C" /><stop offset="1" stopColor="#B81E9A" />
            </linearGradient>
          </defs>
          {/* Fireflies magenta rounded-tile mark */}
          <rect x="7"  y="7"  width="15.5" height="15.5" rx="4.5" fill="url(#ffG)" />
          <rect x="25.5" y="7"  width="15.5" height="15.5" rx="4.5" fill="#F77FC4" />
          <rect x="7"  y="25.5" width="15.5" height="15.5" rx="4.5" fill="#F77FC4" />
          <rect x="25.5" y="25.5" width="15.5" height="15.5" rx="4.5" fill="url(#ffG)" />
        </svg>
      );
    case 'google_meet':
    case 'meet':
      return (
        <svg viewBox="0 0 87.5 72" style={s} aria-label="Google Meet">
          <path fill="#00832d" d="M49.5 36l8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z" />
          <path fill="#0066da" d="M0 51.5V66c0 3.315 2.685 6 6 6h14.5l3-10.96-3-9.54-9.95-3z" />
          <path fill="#e94235" d="M20.5 0L0 20.5l10.55 3 9.95-3 2.95-9.41z" />
          <path fill="#2684fc" d="M20.5 20.5H0v31h20.5z" />
          <path fill="#00ac47" d="M82.6 8.68L69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.135 4.85-2.37V11c0-2.535-2.945-3.925-4.91-2.32zM49.5 36v15.5h-29V72h43c3.315 0 6-2.685 6-6V53.08z" />
          <path fill="#ffba00" d="M63.5 0h-43v20.5h29V36l20-16.58V6c0-3.315-2.685-6-6-6z" />
        </svg>
      );
    case 'google_calendar':
    case 'gcal':
    case 'calendar':
      return (
        <svg viewBox="0 0 48 48" style={s} aria-label="Google Calendar">
          <rect x="10" y="10" width="28" height="28" rx="3" fill="#fff" />
          <path fill="#4285f4" d="M38 14h-4v-4h1a3 3 0 0 1 3 3z" />
          <path fill="#ea4335" d="M14 10a4 4 0 0 0-4 4h4z" />
          <path fill="#fbbc04" d="M10 34h4v4a4 4 0 0 1-4-4z" />
          <path fill="#34a853" d="M34 38v-4h4a4 4 0 0 1-4 4z" />
          <path fill="#188038" d="M34 34h4V14h-4z" />
          <path fill="#1967d2" d="M14 34h20v4H14z" />
          <rect x="10" y="14" width="4" height="20" fill="#4285f4" />
          <rect x="14" y="10" width="20" height="4" fill="#4285f4" />
          <text x="24" y="31" fontSize="16" fontWeight="700" fill="#4285f4" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif">31</text>
        </svg>
      );
    case 'zoom':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-label="Zoom">
          <circle cx="20" cy="20" r="20" fill="#2D8CFF" />
          <path fill="#fff" d="M10 15.2c0-1.2.97-2.2 2.17-2.2h8.6c1.2 0 2.17 1 2.17 2.2v9.6c0 1.2-.97 2.2-2.17 2.2h-8.6c-1.2 0-2.17-1-2.17-2.2zM24.1 17.4l4.4-3.2c.57-.42 1.5-.02 1.5.78v10.1c0 .8-.93 1.2-1.5.78l-4.4-3.2z" />
        </svg>
      );
    case 'google_drive':
    case 'drive':
      return (
        <svg viewBox="0 0 87.3 78" style={s} aria-label="Google Drive">
          <path fill="#0066da" d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" />
          <path fill="#00ac47" d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44A9.06 9.06 0 000 53h27.5z" />
          <path fill="#ea4335" d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z" />
          <path fill="#00832d" d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" />
          <path fill="#2684fc" d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
          <path fill="#ffba00" d="M73.4 26.5l-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" />
        </svg>
      );
    case 'claude':
    case 'anthropic':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-label="Claude">
          <rect width="24" height="24" rx="5" fill="#D97757" />
          <path fill="#fff" d="M7.4 15.6l3.05-7.2h1.55l3.05 7.2h-1.6l-.62-1.57h-3.2l-.62 1.57zm2.7-2.86h2.2l-1.1-2.83z" />
        </svg>
      );
    case 'openai':
    case 'chatgpt':
      return (
        <svg viewBox="0 0 24 24" style={s} aria-label="OpenAI">
          <rect width="24" height="24" rx="5" fill="#000" />
          <path fill="#fff" d="M12 5.5a3.2 3.2 0 012.77 1.6 3.2 3.2 0 011.9 5.4 3.2 3.2 0 01-2.77 4.8A3.2 3.2 0 0112 18.5a3.2 3.2 0 01-2.77-1.2 3.2 3.2 0 01-1.9-5.4A3.2 3.2 0 0110.1 7.1 3.2 3.2 0 0112 5.5zm0 1.6l-2.4 1.38v2.0L12 12.3l2.4-1.42v-2L12 7.1z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" style={s} aria-label={type || 'integration'} fill="none" stroke="#64748B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5" />
        </svg>
      );
  }
}
