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
    default:
      return (
        <svg viewBox="0 0 24 24" style={s} aria-label={type || 'integration'} fill="none" stroke="#64748B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5" />
        </svg>
      );
  }
}
