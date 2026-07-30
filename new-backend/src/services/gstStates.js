/* ──────────────────────────────────────────────────────────────────────────────
   gstStates.js — GST state codes + extracting a state from a filename.

   Used by the multi-state Drive router to pair each state's files:
     • a GSTR-2B / e-invoice file carries a GSTIN → first 2 digits = state code
       (e.g. "EINV_07ABGCS4796R1Z8_2025-26.xlsx" → "07" → Delhi).
     • the Purchase Register / Debit Note file for that state usually carries the
       state name or code in its filename.
   ────────────────────────────────────────────────────────────────────────────── */

// GST state/UT code → canonical name.
const CODE_TO_STATE = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli', '27': 'Maharashtra', '28': 'Andhra Pradesh',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

// Common name / abbreviation → code (lowercased keys). Includes a few aliases.
const NAME_TO_CODE = (() => {
  const m = {};
  for (const [code, name] of Object.entries(CODE_TO_STATE)) m[name.toLowerCase()] = code;
  Object.assign(m, {
    'j&k': '01', 'jk': '01', 'hp': '02', 'uk': '05', 'ua': '05', 'uttaranchal': '05',
    'delhi ncr': '07', 'new delhi': '07', 'ncr': '07', 'up': '09', 'mp': '23',
    'wb': '19', 'bengal': '19', 'ap': '37', 'mh': '27', 'maha': '27', 'ka': '29',
    'karnatka': '29', 'tn': '33', 'tamilnadu': '33', 'ts': '36', 'telengana': '36',
    'gj': '24', 'guj': '24', 'rj': '08', 'raj': '08', 'hr': '06', 'pb': '03', 'punj': '03',
    'og': '21', 'odisha': '21', 'orissa': '21', 'cg': '22', 'chattisgarh': '22',
  });
  return m;
})();

const codeToState = (code) => CODE_TO_STATE[code] || null;

// Strict-ish GSTIN token: 2 digits + 5 letters + 4 digits + letter + 3 alnum.
const GSTIN_RE = /\b(\d{2})[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}\b/i;

/**
 * Best-effort state code from a filename. Priority:
 *   1) GSTIN embedded in the name → first 2 digits.
 *   2) A known state name / abbreviation appears in the name.
 *   3) A bare valid 2-digit state code delimited by non-digits (last resort).
 * Returns { code, label, via } or null.
 */
function extractState(name) {
  const raw = String(name || '');
  const gm = raw.match(GSTIN_RE);
  if (gm && CODE_TO_STATE[gm[1]]) return { code: gm[1], label: CODE_TO_STATE[gm[1]], via: 'gstin' };

  const lower = raw.toLowerCase();
  // Longest name first so "andhra pradesh" wins over a stray short alias.
  const names = Object.keys(NAME_TO_CODE).sort((a, b) => b.length - a.length);
  for (const nm of names) {
    // word-ish boundary to avoid matching inside another word
    const re = new RegExp(`(^|[^a-z])${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(lower)) return { code: NAME_TO_CODE[nm], label: CODE_TO_STATE[NAME_TO_CODE[nm]], via: 'name' };
  }

  const bare = raw.match(/(?:^|[^0-9])(0[1-9]|[12]\d|3[0-8])(?:[^0-9]|$)/);
  if (bare && CODE_TO_STATE[bare[1]]) return { code: bare[1], label: CODE_TO_STATE[bare[1]], via: 'code' };

  return null;
}

module.exports = { CODE_TO_STATE, NAME_TO_CODE, codeToState, extractState };
