const { validateWorkflowDraft } = require('../validators/workflowDraftValidator');

// Genspark's LLM proxy — OpenAI-compatible chat completions API, proxying real Claude model IDs
// (confirmed live: POST {GSK_BASE_URL}/chat/completions, Authorization: Bearer <GSK_API_KEY>).
const GSK_BASE_URL = process.env.GSK_BASE_URL || 'https://www.genspark.ai/api/llm_proxy/v1';
const GSK_MODEL = process.env.GSK_MODEL || 'claude-opus-4-8';

const FILTER_OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'gt', 'lt', 'is_empty', 'is_not_empty'];
const AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max', 'first', 'last', 'concat'];

// ─── Tool schemas (strict) ─────────────────────────────────────────────────────

const FILTER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'column', 'operator', 'value'],
  properties: {
    id: { type: 'string' },
    column: { type: 'string' },
    operator: { type: 'string', enum: FILTER_OPERATORS },
    value: { type: 'string' }
  }
};

const COLUMN_SCHEMA = {
  anyOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'label', 'order', 'type', 'key'],
      properties: {
        id: { type: 'string' }, label: { type: 'string' }, order: { type: 'integer' },
        type: { type: 'string', enum: ['source'] }, key: { type: 'string' }
      }
    },
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'label', 'order', 'type', 'formula'],
      properties: {
        id: { type: 'string' }, label: { type: 'string' }, order: { type: 'integer' },
        type: { type: 'string', enum: ['computed', 'excel'] }, formula: { type: 'string' }
      }
    },
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'label', 'order', 'type', 'masterType', 'lookupColumn', 'matchField', 'returnField'],
      properties: {
        id: { type: 'string' }, label: { type: 'string' }, order: { type: 'integer' },
        type: { type: 'string', enum: ['master_lookup'] },
        masterType: { type: 'string', enum: ['sku', 'ledger'] },
        lookupColumn: { type: 'string' }, matchField: { type: 'string' }, returnField: { type: 'string' }
      }
    },
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'label', 'order', 'type', 'masterType', 'lookupColumn', 'matchField', 'matchLabel', 'noMatchLabel'],
      properties: {
        id: { type: 'string' }, label: { type: 'string' }, order: { type: 'integer' },
        type: { type: 'string', enum: ['master_validate'] },
        masterType: { type: 'string', enum: ['sku', 'ledger'] },
        lookupColumn: { type: 'string' }, matchField: { type: 'string' },
        matchLabel: { type: 'string' }, noMatchLabel: { type: 'string' }
      }
    }
  ]
};

const GROUPBY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['enabled', 'columns', 'aggregations'],
  properties: {
    enabled: { type: 'boolean' },
    columns: { type: 'array', items: { type: 'string' } },
    aggregations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['column', 'method'],
        properties: { column: { type: 'string' }, method: { type: 'string', enum: AGGREGATIONS } }
      }
    }
  }
};

const SHEET_SCHEMA = {
  anyOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'name', 'order', 'sourceType', 'fileInputId', 'rawSheetName', 'prevSheetName', 'filters', 'columns', 'groupBy'],
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, order: { type: 'integer' },
        sourceType: { type: 'string', enum: ['raw', 'prev_sheet'] },
        fileInputId: { type: ['string', 'null'] },
        rawSheetName: { type: ['string', 'null'] },
        prevSheetName: { type: ['string', 'null'] },
        filters: { type: 'array', items: FILTER_SCHEMA },
        columns: { type: 'array', items: COLUMN_SCHEMA },
        groupBy: GROUPBY_SCHEMA
      }
    },
    {
      type: 'object', additionalProperties: false,
      required: ['id', 'name', 'order', 'type', 'mergeConfig'],
      properties: {
        id: { type: 'string' }, name: { type: 'string' }, order: { type: 'integer' },
        type: { type: 'string', enum: ['merge'] },
        mergeConfig: {
          type: 'object', additionalProperties: false,
          required: ['mergeType', 'commonJoinKey', 'sources'],
          properties: {
            mergeType: { type: 'string', enum: ['join', 'stack', 'column_combine'] },
            commonJoinKey: { type: ['string', 'null'] },
            sources: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false,
                required: ['type', 'sheetName', 'columns', 'joinKey'],
                properties: {
                  type: { type: 'string', enum: ['raw', 'output'] },
                  sheetName: { type: 'string' },
                  columns: { type: 'array', items: { type: 'string' } },
                  joinKey: { type: ['string', 'null'] }
                }
              }
            }
          }
        }
      }
    }
  ]
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ask_clarifying_question',
      description: 'Ask the admin one clarifying question because the SOP is ambiguous or missing information needed to build the workflow.',
      strict: true,
      parameters: {
        type: 'object', additionalProperties: false, required: ['question'],
        properties: { question: { type: 'string' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'emit_workflow_draft',
      description: 'Emit a complete draft workflow definition matching the sheets/columns/filters schema described in the system prompt.',
      strict: true,
      parameters: {
        type: 'object', additionalProperties: false, required: ['summary', 'draft'],
        properties: {
          summary: { type: 'string' },
          draft: {
            type: 'object', additionalProperties: false,
            required: ['name', 'description', 'fileInputs', 'sheets'],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              fileInputs: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['id', 'label'],
                  properties: { id: { type: 'string' }, label: { type: 'string' } }
                }
              },
              sheets: { type: 'array', items: SHEET_SCHEMA }
            }
          }
        }
      }
    }
  }
];

const SYSTEM_SCHEMA_PROMPT = `You convert an admin's plain-English SOP for a data-processing workflow into a structured draft, using the same schema an internal "workflow builder" already executes.

A workflow has: name, description, fileInputs (list of upload slots, each {id, label}), and sheets (processed in order).

Each sheet is either a NORMAL sheet or a MERGE sheet.

NORMAL sheet fields:
- sourceType: "raw" (reads rows from an uploaded file's sheet named by rawSheetName) or "prev_sheet" (chains onto an earlier sheet's already-processed output, named by prevSheetName).
- fileInputId: which uploaded file this sheet reads from (only relevant for sourceType "raw" with multiple file inputs; otherwise null).
- filters: WHERE conditions ANDed together, each {column, operator, value}. operator is one of: equals, not_equals, contains, not_contains, gt, lt, is_empty, is_not_empty. "column" must be a real column available on this sheet's input (a raw file header, or the previous sheet's own output column when sourceType is prev_sheet) — never invent a column name.
- columns: the output columns, each with a unique "order" controlling both output order and evaluation order. Five types:
  - "source": passthrough of a raw column. key = the exact raw column header.
  - "computed": per-row math using {ColumnLabel} tokens for values in this row, e.g. "{Qty} * {Rate}". Supports IF(condition, thenValue, elseValue). May also reference a column from an earlier-listed sheet using the token {SheetName.ColumnLabel}.
  - "excel": cross-row formulas using the functions SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF, VLOOKUP, MAXIF, MINIF. Inside these functions, "ColumnLabel" (double-quoted) means "the whole column of values", and {ColumnLabel} means "this row's value" — e.g. SUMIF("SKU", {SKU}, "Net") sums the "Net" column for rows whose "SKU" column matches this row's SKU.
  - "master_lookup": looks a value up against SKU or ledger master data. lookupColumn = the sheet column to match on, masterType = "sku" or "ledger", matchField = the master-data field to match against, returnField = the master-data field to return.
  - "master_validate": same lookup mechanics but only returns matchLabel (e.g. "Matched") or noMatchLabel (e.g. "Not Matched") instead of a value.
  Formulas may ONLY reference: real column labels (own sheet, or an earlier sheet via SheetName.Label), the listed function names, numeric/string literals, and basic arithmetic/comparison operators. Never emit arbitrary code, method calls, or anything resembling a scripting language — only the formula grammar described above.
- groupBy: optional aggregation. When enabled, columns lists the group-by key columns, and aggregations pairs every remaining column with a method: sum, avg, count, min, max, first, last, concat.

MERGE sheet fields (type: "merge"):
- mergeConfig.mergeType: "join" (N-way sequential left join on mergeConfig.commonJoinKey, present in every source), "stack" (concatenate rows from all sources vertically), or "column_combine" (zip rows from exactly two sources side by side by position).
- mergeConfig.sources: 2+ entries, each {type: "raw" | "output", sheetName, columns}. type "raw" reads a sheet directly from an uploaded file (sheetName is a real sheet name in that file); type "output" reads an earlier sheet already defined in this workflow (sheetName matches that sheet's name exactly).

Only ever use real column names and real sheet names given to you in this conversation's context — never invent one. If the SOP is ambiguous about which real column plays a given role, ask a clarifying question instead of guessing.

Every turn, call exactly one tool: "ask_clarifying_question" if you need more information before you can build an accurate draft, or "emit_workflow_draft" once you have enough information for a complete, runnable draft.`;

function buildContextBlock({ fileInputs = [], fileSheetsMap = {}, masterSchema = {} }) {
  const lines = ['Available data for this workflow:', ''];
  lines.push('File inputs: ' + JSON.stringify(fileInputs));
  lines.push('');
  lines.push('Sheets and columns per file input:');
  lines.push(JSON.stringify(fileSheetsMap, null, 2));
  if (masterSchema && ((masterSchema.sku && masterSchema.sku.length) || (masterSchema.ledger && masterSchema.ledger.length))) {
    lines.push('');
    lines.push('Master data fields available for master_lookup/master_validate columns:');
    lines.push(JSON.stringify(masterSchema, null, 2));
  }
  return lines.join('\n');
}

function aggregationsArrayToMap(aggregations) {
  const map = {};
  (aggregations || []).forEach(({ column, method }) => { map[column] = method; });
  return map;
}

function normalizeDraft(draft) {
  const sheets = (draft.sheets || []).map(sheet => {
    if (sheet.type === 'merge') {
      return {
        id: sheet.id, name: sheet.name, order: sheet.order, type: 'merge',
        mergeConfig: sheet.mergeConfig,
        columns: [], filters: [], groupBy: { enabled: false, columns: [], aggregations: {} }
      };
    }
    return {
      ...sheet,
      groupBy: {
        enabled: !!sheet.groupBy?.enabled,
        columns: sheet.groupBy?.columns || [],
        aggregations: aggregationsArrayToMap(sheet.groupBy?.aggregations)
      }
    };
  });
  return { ...draft, sheets };
}

function extractToolCall(message) {
  const toolCall = (message?.tool_calls || [])[0];
  if (!toolCall) return null;
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments)
  };
}

// ── GenSpark retired (credits exhausted) → Gemini function-calling PRIMARY,
//    Claude tool-use FALLBACK. Both adapted to the OpenAI completion shape this
//    controller already consumes, so aiChat's logic is unchanged.
const WF_GEMINI_MODEL = process.env.WORKFLOW_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const WF_CLAUDE_MODEL = process.env.WORKFLOW_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// Gemini function parameters use an OpenAPI subset — strip fields it rejects.
function sanitizeSchema(s) {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (s && typeof s === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'additionalProperties' || k === 'strict') continue;
      o[k] = sanitizeSchema(v);
    }
    return o;
  }
  return s;
}
const GEMINI_FUNCS = TOOLS.map(t => ({ name: t.function.name, description: t.function.description, parameters: sanitizeSchema(t.function.parameters) }));
const CLAUDE_TOOLS = TOOLS.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));

let _tcSeq = 0;
const toolCallId = () => `call_${Date.now()}_${_tcSeq++}`;

// OpenAI messages -> Gemini contents (user / assistant-with-tool_calls / tool result)
function toGeminiContents(messages) {
  const idToName = {}; const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', parts: [{ text: String(m.content || '') }] });
    else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of (m.tool_calls || [])) {
        idToName[tc.id] = tc.function.name;
        let args = {}; try { args = JSON.parse(tc.function.arguments); } catch (_) {}
        parts.push({ functionCall: { name: tc.function.name, args } });
      }
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', parts: [{ functionResponse: { name: idToName[m.tool_call_id] || 'tool', response: { result: String(m.content || '') } } }] });
    }
  }
  return out;
}

// OpenAI messages -> Claude messages
function toClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: String(m.content || '') });
    else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const tc of (m.tool_calls || [])) {
        let input = {}; try { input = JSON.parse(tc.function.arguments); } catch (_) {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: 'assistant', content: content.length ? content : String(m.content || '') });
    } else if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') }] });
    }
  }
  return out;
}

async function geminiToolCall({ systemPrompt, messages, forceEmitOnly }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: toGeminiContents(messages),
    tools: [{ functionDeclarations: GEMINI_FUNCS }],
    toolConfig: { functionCallingConfig: forceEmitOnly ? { mode: 'ANY', allowedFunctionNames: ['emit_workflow_draft'] } : { mode: 'ANY' } },
    generationConfig: { maxOutputTokens: 8192, temperature: 0, thinkingConfig: { thinkingBudget: 0 } },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${WF_GEMINI_MODEL}:generateContent?key=${key}`;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 220)}`);
  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('');
  const tool_calls = parts.filter(p => p.functionCall).map(p => ({ id: toolCallId(), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }));
  if (!tool_calls.length) throw new Error('Gemini returned no tool call');
  return { choices: [{ message: { role: 'assistant', content: text, tool_calls } }] };
}

async function claudeToolCall({ systemPrompt, messages, forceEmitOnly }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const body = {
    model: WF_CLAUDE_MODEL, max_tokens: 8192, system: systemPrompt, tools: CLAUDE_TOOLS,
    tool_choice: forceEmitOnly ? { type: 'tool', name: 'emit_workflow_draft' } : { type: 'any' },
    messages: toClaudeMessages(messages),
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) { const err = new Error(data?.error?.message || `Anthropic returned ${resp.status}`); err.status = resp.status; throw err; }
  const blocks = data?.content || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const tool_calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
  return { choices: [{ message: { role: 'assistant', content: text, tool_calls: tool_calls.length ? tool_calls : undefined } }] };
}

async function callGenspark({ systemPrompt, messages, forceEmitOnly }) {
  try {
    return await geminiToolCall({ systemPrompt, messages, forceEmitOnly });
  } catch (e) {
    console.warn('[workflow-ai] Gemini failed, falling back to Claude:', e.message);
    return await claudeToolCall({ systemPrompt, messages, forceEmitOnly });
  }
}

const aiChat = async (req, res, next) => {
  try {
    const { fileInputs = [], fileSheetsMap = {}, masterSchema = {}, messages = [] } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }

    const systemPrompt = SYSTEM_SCHEMA_PROMPT + '\n\n' + buildContextBlock({ fileInputs, fileSheetsMap, masterSchema });
    const chatMessages = messages.map(m => ({ role: m.role, content: m.content }));

    let completion = await callGenspark({ systemPrompt, messages: chatMessages });
    let choice = completion.choices?.[0];

    let toolCall = extractToolCall(choice?.message);
    if (!toolCall) {
      return res.json({ message: 'ok', data: { type: 'error', errors: [{ message: 'The model did not return a usable response.' }] } });
    }

    if (toolCall.name === 'ask_clarifying_question') {
      return res.json({ message: 'ok', data: { type: 'question', question: toolCall.input.question } });
    }

    let summary = toolCall.input.summary;
    let draft = normalizeDraft(toolCall.input.draft);
    let validation = validateWorkflowDraft(draft, { fileSheetsMap, masterSchema });

    if (!validation.valid) {
      const retryMessages = [
        ...chatMessages,
        { role: 'assistant', content: choice.message.content || '', tool_calls: choice.message.tool_calls },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'The draft failed validation:\n' + validation.errors.map(e => `- ${e.path}: ${e.message}`).join('\n') + '\nEmit a corrected emit_workflow_draft call that fixes every issue.'
        }
      ];
      completion = await callGenspark({ systemPrompt, messages: retryMessages, forceEmitOnly: true });
      choice = completion.choices?.[0];
      toolCall = extractToolCall(choice?.message);
      if (!toolCall || toolCall.name !== 'emit_workflow_draft') {
        return res.json({ message: 'ok', data: { type: 'error', errors: [{ message: 'The model could not produce a valid draft.' }] } });
      }
      summary = toolCall.input.summary;
      draft = normalizeDraft(toolCall.input.draft);
      validation = validateWorkflowDraft(draft, { fileSheetsMap, masterSchema });
      if (!validation.valid) {
        return res.json({ message: 'ok', data: { type: 'error', errors: validation.errors } });
      }
    }

    return res.json({ message: 'ok', data: { type: 'draft', summary, draft } });
  } catch (error) {
    next(error);
  }
};

module.exports = { aiChat };
