"""Minimal evaluator for the formula grammar this workbook uses.
Supports: cell refs, + - * /, unary minus, numbers, SUM(range), ROUND(x,n),
IFERROR(x,y), parentheses. Resolves referenced formulas recursively with cycle
detection, so a value is checked the way Excel would compute it."""
import re
from openpyxl.utils import column_index_from_string, get_column_letter

TOK = re.compile(r"\s*(\$?[A-Z]{1,3}\$?\d+|\d+\.?\d*|[-+*/(),]|[A-Z]+)")

class Calc:
    def __init__(self, ws):
        self.ws = ws
        self.memo = {}
        self.stack = set()

    def cell(self, ref):
        ref = ref.replace('$', '')
        if ref in self.memo:
            return self.memo[ref]
        if ref in self.stack:
            raise ValueError(f'circular reference at {ref}')
        m = re.match(r'([A-Z]{1,3})(\d+)', ref)
        col, row = column_index_from_string(m.group(1)), int(m.group(2))
        v = self.ws.cell(row, col).value
        self.stack.add(ref)
        try:
            if isinstance(v, str) and v.startswith('='):
                out = self.eval(v[1:])
            elif isinstance(v, (int, float)):
                out = float(v)
            else:
                out = 0.0
        finally:
            self.stack.discard(ref)
        self.memo[ref] = out
        return out

    def eval(self, expr):
        # re-entrant: evaluating a referenced cell parses its own formula, which
        # would otherwise clobber the parse state of the formula that called it
        saved = (getattr(self, 'toks', None), getattr(self, 'i', 0))
        self.toks = [t for t in TOK.findall(expr) if t.strip()]
        self.i = 0
        try:
            v = self.expr()
            if self.i != len(self.toks):
                raise ValueError(f'unparsed tail in {expr!r}: {self.toks[self.i:]}')
            return v
        finally:
            self.toks, self.i = saved

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else None

    def expr(self):
        v = self.term()
        while self.peek() in ('+', '-'):
            op = self.toks[self.i]; self.i += 1
            r = self.term()
            v = v + r if op == '+' else v - r
        return v

    def term(self):
        v = self.factor()
        while self.peek() in ('*', '/'):
            op = self.toks[self.i]; self.i += 1
            r = self.factor()
            v = v * r if op == '*' else (v / r if r else float('inf'))
        return v

    def factor(self):
        t = self.peek()
        if t == '-':
            self.i += 1; return -self.factor()
        if t == '+':
            self.i += 1; return self.factor()
        if t == '(':
            self.i += 1; v = self.expr(); assert self.toks[self.i] == ')'; self.i += 1; return v
        if re.fullmatch(r'[A-Z]+', t) and self.i + 1 < len(self.toks) and self.toks[self.i + 1] == '(':
            return self.func(t)
        if re.fullmatch(r'\$?[A-Z]{1,3}\$?\d+', t):
            self.i += 1; return self.cell(t)
        if re.fullmatch(r'\d+\.?\d*', t):
            self.i += 1; return float(t)
        raise ValueError(f'unexpected token {t!r}')

    def args(self):
        self.i += 1  # name
        assert self.toks[self.i] == '('; self.i += 1
        out = []
        if self.peek() == ')':
            self.i += 1; return out
        while True:
            out.append(self.expr())
            if self.peek() == ',':
                self.i += 1; continue
            assert self.toks[self.i] == ')', self.toks[self.i:]
            self.i += 1; return out

    def func(self, name):
        if name == 'SUM':
            # SUM(A1:A9) — the range colon is not a token, so re-read from source
            j = self.i
            assert self.toks[j + 1] == '('
            a, b = self.toks[j + 2], self.toks[j + 3] if self.toks[j + 3] != ')' else None
            # tokens for "A1:A9" come through as A1 then A9 (the colon is dropped)
            self.i = j + 2
            first = self.toks[self.i]; self.i += 1
            last = self.toks[self.i]; self.i += 1
            assert self.toks[self.i] == ')'; self.i += 1
            m1 = re.match(r'([A-Z]{1,3})(\d+)', first.replace('$', ''))
            m2 = re.match(r'([A-Z]{1,3})(\d+)', last.replace('$', ''))
            c1, r1 = column_index_from_string(m1.group(1)), int(m1.group(2))
            c2, r2 = column_index_from_string(m2.group(1)), int(m2.group(2))
            tot = 0.0
            for rr in range(min(r1, r2), max(r1, r2) + 1):
                for cc in range(min(c1, c2), max(c1, c2) + 1):
                    tot += self.cell(f'{get_column_letter(cc)}{rr}')
            return tot
        if name == 'ROUND':
            a = self.args(); return round(a[0], int(a[1]))
        if name == 'IFERROR':
            try:
                a = self.args()
            except ZeroDivisionError:
                return 0.0
            v = a[0]
            return a[1] if (v != v or v in (float('inf'), float('-inf'))) else v
        raise ValueError(f'unsupported function {name}')
