/* ── Colonel AI — pre-gate + heuristic intent (NO extra LLM call) ───────────
   Cheap, deterministic regex/keyword screening that runs before every
   "Ask Colonel AI" request hits the model. This is the security fence:
   - preGate() hard-refuses secrets/infra-fishing and general code-writing
     requests without spending a token on a classification call.
   - heuristicIntent() picks a cheap intent bucket ('app_help' | 'finance' |
     'general') used to decide whether to splice in help-blurb / finance
     framing when building the system prompt (see ./prompts).
   Both are pure functions — no I/O, no LLM call.                          */

const { REFUSALS } = require('./prompts');

/* ── secrets / infra-fishing patterns (highest priority) ────────────────── */
// Word-boundary care: `token` must not match "tokenized"/"tokenizer" etc.,
// so it is anchored with \b on both sides.
const SECRET_PATTERNS = [
  /\.env\b/i,
  /\benv(ironment)? var(iable)?s?\b/i,
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bpwd\b/i,
  /\bdb password\b/i,
  /\bconnection string\b/i,
  /\b(database|db) url\b/i,
  /\bapi[\s-]?key\b/i,
  /\bsecret( key)?\b/i,
  /\btoken\b/i,
  /\bcredential(s)?\b/i,
  /\bcreds\b/i,
  /\bservice account\b/i,
  /\bprivate key\b/i,
  /\bjwt\b/i,
  /\bsystem prompt\b/i,
  /\byour (instructions|prompt)\b/i,
  /\bignore (previous instructions|all previous)\b/i,
  /\breveal your\b/i,
  /\bshow me the sql\b/i,
  /\braw json\b/i,
];

/* ── code-writing patterns ───────────────────────────────────────────────── */
const CODE_PATTERNS = [
  /\bwrite (me )?(a |some )?(code|program|script|function)\b/i,
  /\bpython script\b/i,
  /\bjavascript\b/i,
  /\bjs code\b/i,
  /\bsql query for\b/i,
  /\bleetcode\b/i,
  /\bregex for\b/i,
  /\bbash script\b/i,
  /\bwrite a class\b/i,
  /\bimplement a\b/i,
];

/* ── app_help (how-to / troubleshooting) signals ─────────────────────────── */
const HELP_PATTERNS = [
  /\bhow (do|to|can) i\b/i,
  /\bhow do i use\b/i,
  /\bnot working\b/i,
  /\b(won't|doesn't|does not) work\b/i,
  /\bwhy (isn't|is not|won't) .*(fetch|load|work|upload)/i,
  /\bwhere (is|do)\b/i,
  /\bwhat does this (do|mean)\b/i,
  /\bdrive link\b/i,
  /\bpaste .*link\b/i,
  /\bupload\b/i,
  /\bopen in (google )?sheets\b/i,
  /\bdownload excel\b/i,
  /\bselect .*agent\b/i,
  /\bsteps to\b/i,
];

/* ── finance (Indian-tax) signals ────────────────────────────────────────── */
const FINANCE_PATTERNS = [
  /\bgst\b/i,
  /\bgstr\b/i,
  /\b2b\b/i,
  /\b2a\b/i,
  /\b3b\b/i,
  /\bitc\b/i,
  /\brcm\b/i,
  /\btds\b/i,
  /\btcs\b/i,
  /\bhsn\b/i,
  /\bsac\b/i,
  /\binput tax\b/i,
  /\breverse charge\b/i,
  /\bincome tax\b/i,
  /\bdue date\b/i,
  /\bfiling\b/i,
  /\bnotification\b/i,
  /\bsection \d/i,
  /\bcess\b/i,
  /\be-invoice\b/i,
  /\birn\b/i,
  /\be-way\b/i,
];

/**
 * Cheap security/scope pre-gate. Runs BEFORE any LLM call.
 * The message is normalized so that underscores/hyphens are treated as
 * spaces before matching — this closes the env-var-name bypass class
 * (DATABASE_URL, JWT_SECRET, *_API_KEY, DB_PASSWORD, PRIVATE_KEY, api-key,
 * …) where `\b` would not break on `_`, letting a real secret ask slip
 * through untouched. Normalizing only merges separators to spaces, so any
 * legitimate space-delimited match is preserved (false-positive-safe bias,
 * which is the correct bias for a security fence).
 * @param {string} message - raw user message.
 * @returns {{refuse:true, category:'secrets'|'code', text:string}|null}
 */
function preGate(message) {
  const norm = String(message || '').replace(/[_-]+/g, ' ');

  if (SECRET_PATTERNS.some((re) => re.test(norm))) {
    return { refuse: true, category: 'secrets', text: REFUSALS.secrets };
  }

  if (CODE_PATTERNS.some((re) => re.test(norm))) {
    return { refuse: true, category: 'code', text: REFUSALS.code };
  }

  return null;
}

/**
 * Cheap intent bucket for prompt-shaping. NO LLM call.
 * app_help beats finance when both signal sets match.
 * @param {string} message - raw user message.
 * @returns {'app_help'|'finance'|'general'}
 */
function heuristicIntent(message) {
  const msg = String(message || '');

  if (HELP_PATTERNS.some((re) => re.test(msg))) return 'app_help';
  if (FINANCE_PATTERNS.some((re) => re.test(msg))) return 'finance';
  return 'general';
}

module.exports = { preGate, heuristicIntent, SECRET_PATTERNS, CODE_PATTERNS, HELP_PATTERNS, FINANCE_PATTERNS };
