/**
 * extract.js — PDF text extraction + the Anthropic (Claude) extraction call.
 *
 * Mirrors the n8n pipeline: n8n "Extract from File (pdf)" → text, then the
 * LangChain "AI Agent" on Claude Haiku 4.5 (temp 0). Here we extract text with
 * pdf-parse and call the Anthropic SDK directly with the SAME prompt.
 */
const { PDFParse } = require('pdf-parse'); // pdf-parse v2 API
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in the environment.');
  _client = new Anthropic({ apiKey });
  return _client;
}

/** Extract text from a PDF buffer (pdf-parse v2). Returns '' if none/empty. */
async function extractPdfText(buffer) {
  try {
    const parser = new PDFParse({ data: Buffer.from(buffer) });
    const res = await parser.getText();
    return (res && res.text) ? res.text : '';
  } catch (e) {
    return '';
  }
}

/**
 * Run the Claude extraction on TEXT. `promptText` is the fully-built prompt
 * (brand buildPrompt(invoiceText)). Returns the raw model string (a JSON array).
 */
async function runExtraction(promptText) {
  const msg = await client().messages.create({
    model: MODEL,
    max_tokens: 8192,
    temperature: 0,
    messages: [{ role: 'user', content: promptText }],
  });
  const parts = (msg.content || []).filter(b => b.type === 'text').map(b => b.text);
  return parts.join('').trim();
}

module.exports = { extractPdfText, runExtraction, MODEL };
