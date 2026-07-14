/**
 * statutoryMeta.js — shared contract for the Statutory Compliance tracker.
 * Private feature: only visible/usable by STATUTORY_OWNER_EMAIL.
 * Keys/colors here MUST match new-backend/src/data/statutoryTemplate.js.
 */
export const STATUTORY_OWNER_EMAIL = 'chauhandhaval932@gmail.com';

// The 15 statutory obligations, each its own colored category.
export const STATUTORY_CATEGORIES = [
  { key: 'gstr_1',            name: 'GSTR-1',              color: '#0748EE', group: 'GST',        stateWise: true  },
  { key: 'gstr_3b',           name: 'GSTR-3B',             color: '#2563EB', group: 'GST',        stateWise: true  },
  { key: 'tds_payment',       name: 'TDS Payment',         color: '#D97706', group: 'TDS',        stateWise: false },
  { key: 'tds_26q',           name: 'TDS Return 26Q',      color: '#F59E0B', group: 'TDS',        stateWise: false },
  { key: 'tds_24q',           name: 'TDS Return 24Q',      color: '#B45309', group: 'TDS',        stateWise: false },
  { key: 'pf',                name: 'PF',                  color: '#059669', group: 'Payroll',    stateWise: false },
  { key: 'esic',              name: 'ESIC',                color: '#10B981', group: 'Payroll',    stateWise: false },
  { key: 'pt',                name: 'Professional Tax',    color: '#14B8A6', group: 'Payroll',    stateWise: true  },
  { key: 'itr',               name: 'Income Tax Return',   color: '#7C3AED', group: 'Income Tax', stateWise: false },
  { key: 'tax_audit',         name: 'Tax Audit',           color: '#8B5CF6', group: 'Income Tax', stateWise: false },
  { key: 'dpt_3',             name: 'DPT-3',               color: '#DB2777', group: 'ROC',        stateWise: false },
  { key: 'fla',               name: 'FLA Return',          color: '#EC4899', group: 'ROC',        stateWise: false },
  { key: 'statutory_audit',   name: 'Statutory Audit',     color: '#E11D48', group: 'Audit',      stateWise: false },
  { key: 'mca_annual',        name: 'MCA Annual Filings',  color: '#6366F1', group: 'ROC',        stateWise: false },
  { key: 'other_secretarial', name: 'Other Secretarial',   color: '#0EA5E9', group: 'ROC',        stateWise: false },
];
export const CATEGORY_BY_KEY = Object.fromEntries(STATUTORY_CATEGORIES.map(c => [c.key, c]));

// Build a { key → category } lookup for ANY (per-brand dynamic) category list.
export const buildCategoryMap = (cats) => Object.fromEntries((cats || []).map(c => [c.key, c]));

// Default Kanban columns = statutory statuses (drag between them updates status).
// `terminal: true` marks the "done" column — drives completion % + filing_date.
// Brands with a statutory_config row supply their own columns instead.
export const STATUTORY_STATUS_COLUMNS = [
  { key: 'not_due',        label: 'Not Due',        color: '#64748B' },
  { key: 'pending',        label: 'Pending',        color: '#D97706' },
  { key: 'filed',          label: 'Filed',          color: '#059669', terminal: true },
  { key: 'not_applicable', label: 'Not Applicable', color: '#94A3B8' },
];

export const GST_STATES = ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'Delhi', 'Gujarat', 'West Bengal', 'Telangana', 'Uttar Pradesh', 'Haryana', 'Rajasthan'];
export const PT_STATES  = ['Maharashtra', 'Karnataka', 'Tamil Nadu', 'West Bengal', 'Telangana', 'Gujarat', 'Madhya Pradesh', 'Odisha', 'Assam', 'Kerala'];
export const ALL_STATES = Array.from(new Set([...GST_STATES, ...PT_STATES])).sort();

export const PERIOD_TYPES = [
  { key: 'monthly',   label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual',    label: 'Annual' },
  { key: 'event',     label: 'Event-based' },
];

// Fields for the premium custom filter builder.
export const FILTER_FIELDS = [
  { key: 'category',    label: 'Compliance',            type: 'select', optionSet: 'categories' },
  { key: 'status',      label: 'Status',                type: 'select', optionSet: 'statuses' },
  { key: 'state',       label: 'State',                 type: 'select', optionSet: 'states' },
  { key: 'period_type', label: 'Period type',           type: 'select', optionSet: 'periodTypes' },
  { key: 'month',       label: 'Month',                 type: 'month' },
  { key: 'due_date',    label: 'Due date',              type: 'date' },
  { key: 'filing_date', label: 'Filing date',           type: 'date' },
  { key: 'ack_no',      label: 'Ack / SRN / Challan No.',type: 'text' },
  { key: 'title',       label: 'Title',                 type: 'text' },
];

export const FILTER_OPERATORS = {
  select: [{ key: 'is', label: 'is' }, { key: 'is_not', label: 'is not' }],
  text:   [{ key: 'contains', label: 'contains' }, { key: 'is', label: 'is' }, { key: 'is_not_empty', label: 'has any value' }, { key: 'is_empty', label: 'is empty' }],
  date:   [{ key: 'on', label: 'on' }, { key: 'before', label: 'before' }, { key: 'after', label: 'after' }],
  month:  [{ key: 'is', label: 'is' }],
};

// Apply one custom-filter condition to a filing row (client-side).
export function matchesCondition(row, cond) {
  const v = row[cond.field];
  const val = cond.value;
  switch (cond.op) {
    case 'is':           return String(v ?? '') === String(val ?? '');
    case 'is_not':       return String(v ?? '') !== String(val ?? '');
    case 'contains':     return String(v ?? '').toLowerCase().includes(String(val ?? '').toLowerCase());
    case 'is_empty':     return v === null || v === undefined || v === '';
    case 'is_not_empty': return !(v === null || v === undefined || v === '');
    case 'on':           return (v || '').slice(0, 10) === val;
    case 'before':       return v && (v.slice(0, 10) < val);
    case 'after':        return v && (v.slice(0, 10) > val);
    default:             return true;
  }
}
