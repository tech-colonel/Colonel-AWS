import React from 'react';

/*
 * ChannelLogo — real marketplace/sales-channel brand logos.
 *
 * Assets live in /public/logos/*.svg (served same-origin, CSP-safe). A channel
 * name is matched by substring (e.g. "sales_amazon", "settlement_amazon",
 * "Amazon MTR Consolidator" all → amazon). Channels WITHOUT a bundled logo
 * (meesho, ajio, jiomart, limeroad, mirrow, cread, …) return null so callers
 * fall back to their existing brand-colored monogram / emoji.
 */
export const CHANNEL_LOGO = {
  amazon:   'amazon.svg',
  flipkart: 'flipkart.png',
  myntra:   'myntra.svg',
  nykaa:    'nykaa.svg',
  zepto:    'zepto.svg',
  blinkit:  'blinkit.svg',
  shopify:  'shopify.svg',
  firstcry: 'firstcry.svg',
  jiomart:  'jiomart.svg',
  meesho:   'meesho.svg',
};

/** Return the /logos src for a channel name, or null if there is no bundled logo. */
export function channelLogoSrc(name) {
  const n = String(name || '').toLowerCase();
  for (const k in CHANNEL_LOGO) {
    if (n.includes(k)) return `/logos/${CHANNEL_LOGO[k]}`;
  }
  return null;
}

/**
 * Render a channel's real logo. If none exists, render `fallback` (the caller's
 * existing monogram/emoji) so nothing regresses for unsupported channels.
 */
export default function ChannelLogo({ name, size = 44, style = {}, className = '', fallback = null }) {
  const src = channelLogoSrc(name);
  if (!src) return fallback;
  return (
    <img
      src={src}
      alt={String(name || 'channel')}
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', display: 'block', ...style }}
    />
  );
}
