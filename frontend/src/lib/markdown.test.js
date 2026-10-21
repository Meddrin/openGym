import { describe, it, expect } from 'vitest'
import { parseMarkdown, parseInline } from './markdown.js'

const text = nodes => nodes.map(n => (n.t === 'text' ? n.v : n.v ?? text(n.c || []))).join('')

describe('the assistant\'s markdown', () => {
  it('reads paragraphs, bold, italic, code and lists', () => {
    const b = parseMarkdown('You are **close**.\n\n- add *one* set\n- keep `RIR 2`\n\n1. squat\n2. press')
    expect(b.map(x => x.t)).toEqual(['p', 'ul', 'ol'])
    expect(b[0].c.map(n => n.t)).toEqual(['text', 'b', 'text'])
    expect(b[1].items).toHaveLength(2)
    expect(b[1].items[0].map(n => n.t)).toEqual(['text', 'i', 'text'])
    expect(b[1].items[1][1]).toEqual({ t: 'code', v: 'RIR 2' })
    expect(b[2].items.map(i => text(i))).toEqual(['squat', 'press'])
  })

  it('shows a heading as a heading block, and fenced code as a block of text', () => {
    const b = parseMarkdown('## Plan\ntext\n```\nraw <b>x</b>\n```')
    expect(b.map(x => x.t)).toEqual(['h', 'p', 'pre'])
    expect(text(b[0].c)).toBe('Plan')
    expect(b[2].v).toBe('raw <b>x</b>')
  })

  it('never turns anything into markup: HTML stays as characters', () => {
    const b = parseMarkdown('<img src=x onerror=alert(1)> and <script>alert(2)</script>')
    expect(b).toHaveLength(1)
    expect(text(b[0].c)).toBe('<img src=x onerror=alert(1)> and <script>alert(2)</script>')
    expect(b[0].c.every(n => n.t === 'text')).toBe(true)
  })

  it('keeps a link only when it is http(s); every other scheme is shown as the text it was', () => {
    const ok = parseInline('[the guide](https://example.com/a?b=1)')
    expect(ok).toEqual([{ t: 'a', href: 'https://example.com/a?b=1', c: [{ t: 'text', v: 'the guide' }] }])
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,AAAA', '//evil.example', '/relative', 'ftp://x.example/y', 'JAVASCRIPT:1']) {
      const out = parseInline(`[click](${bad})`)
      expect(out.some(n => n.t === 'a'), bad).toBe(false)
      expect(text(out), bad).toBe(`[click](${bad})`)
    }
  })

  it('does not mistake a snake_case word for emphasis', () => {
    expect(parseInline('snake_case_names').some(n => n.t === 'i')).toBe(false)
    expect(text(parseInline('use snake_case_names'))).toBe('use snake_case_names')
  })

  it('copes with empty, odd and huge input', () => {
    expect(parseMarkdown('')).toEqual([])
    expect(parseMarkdown(null)).toEqual([])
    expect(parseMarkdown('\r\n\r\n')).toEqual([])
    expect(parseMarkdown('**unclosed and `half')).toHaveLength(1)
    const big = 'word '.repeat(50_000) + '**x**'
    const t0 = Date.now()
    expect(parseMarkdown(big)).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  it('keeps a line break inside a paragraph and an indented continuation inside its list item', () => {
    const b = parseMarkdown('line one\nline two\n\n- item\n  continued')
    expect(text(b[0].c)).toBe('line one\nline two')
    expect(text(b[1].items[0])).toBe('item continued')
  })
})
