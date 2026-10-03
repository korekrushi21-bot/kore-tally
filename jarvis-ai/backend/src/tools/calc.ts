/** Safe arithmetic evaluator (no eval). Supports + - * / ^ ( ), unary minus, postfix %, and "x% of y". */
export function calculate(input: string): number {
  const src = input
    .replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/,/g, '')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/gi, '($1/100*$2)');
  let i = 0;
  const peek = () => { while (src[i] === ' ') i++; return src[i]; };
  const fail = (): never => { throw new Error('Invalid expression'); };

  function expr(): number {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v;
    }
  }
  function term(): number {
    let v = power();
    for (;;) {
      const c = peek();
      if (c === '*') { i++; v *= power(); }
      else if (c === '/') { i++; const d = power(); if (d === 0) throw new Error('Division by zero'); v /= d; }
      else return v;
    }
  }
  function power(): number {
    const b = unary();
    if (peek() === '^') { i++; return Math.pow(b, power()); }
    return b;
  }
  function unary(): number {
    if (peek() === '-') { i++; return -unary(); }
    if (peek() === '+') { i++; return unary(); }
    return postfix();
  }
  function postfix(): number {
    let v = atom();
    while (peek() === '%') { i++; v /= 100; }
    return v;
  }
  function atom(): number {
    const c = peek();
    if (c === '(') { i++; const v = expr(); if (peek() !== ')') fail(); i++; return v; }
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) return fail();
    i += m[0].length;
    return parseFloat(m[0]);
  }

  const result = expr();
  if (peek() !== undefined) fail();
  if (!Number.isFinite(result)) fail();
  return result;
}
