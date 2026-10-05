// What an edit changed in a chapter, for showing it in place: whole paragraphs kept, added, or removed, and
// inside a rewritten paragraph the words that went ('-') and the words that came ('+').
export type Para = { kind: 'same' | 'add' | 'del'; text: string } | { kind: 'mod'; parts: ['=' | '+' | '-', string][] }

// Longest common subsequence, as the pairs of indexes that match.
function lcs<T>(a: T[], b: T[]): [number, number][] {
  const w = b.length + 1
  const t = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const out: [number, number][] = []
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) out.push([i++, j++])
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++
    else j++
  }
  return out
}

// Intl.Segmenter rather than spaces: it also finds the words of scripts written without them.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const words = (s: string) => [...segmenter.segment(s)].map(x => x.segment)

// One paragraph rewritten into another, or null when they share too little to read as the same paragraph.
function rewritten(a: string, b: string): Para | null {
  const x = words(a), y = words(b)
  if (x.length * y.length > 4_000_000) return null
  const same = lcs(x, y)
  const real = (list: string[]) => list.filter(s => s.trim()).length
  if (real(same.map(([i]) => x[i])) < 0.3 * Math.max(real(x), real(y))) return null
  const raw: ['=' | '+' | '-', string][] = []
  let i = 0, j = 0
  for (const [p, q] of [...same, [x.length, y.length]]) {
    if (p > i) raw.push(['-', x.slice(i, p).join('')])
    if (q > j) raw.push(['+', y.slice(j, q).join('')])
    if (p < x.length) raw.push(['=', x[p]])
    i = p + 1
    j = q + 1
  }
  // Runs of changes are gathered into one removal and one addition. A lone space kept between two changed
  // words would chop one edit into several, so it joins the change on both sides.
  const parts: ['=' | '+' | '-', string][] = []
  let del = '', add = ''
  const flush = () => {
    if (del) parts.push(['-', del])
    if (add) parts.push(['+', add])
    del = add = ''
  }
  raw.forEach(([op, s], k) => {
    if (op === '-') del += s
    else if (op === '+') add += s
    else if (!s.trim() && (del || add) && raw[k + 1] && raw[k + 1][0] !== '=') (del += s), (add += s)
    else {
      flush()
      if (parts.at(-1)?.[0] === '=') parts.at(-1)![1] += s
      else parts.push(['=', s])
    }
  })
  flush()
  return { kind: 'mod', parts }
}

export function changes(before: string, after: string): Para[] {
  const paras = (t: string) => t.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const a = paras(before), b = paras(after)
  const out: Para[] = []
  let i = 0, j = 0
  for (const [p, q] of [...lcs(a, b), [a.length, b.length]]) {
    // Between two paragraphs that stayed: what was removed is paired, in order, with what was added.
    for (; i < p || j < q; i++, j++) {
      const mod = i < p && j < q ? rewritten(a[i], b[j]) : null
      if (mod) out.push(mod)
      else {
        if (i < p) out.push({ kind: 'del', text: a[i] })
        if (j < q) out.push({ kind: 'add', text: b[j] })
      }
    }
    if (q < b.length) out.push({ kind: 'same', text: b[q] })
    i = p + 1
    j = q + 1
  }
  return out
}
