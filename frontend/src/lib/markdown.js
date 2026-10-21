// A small, safe markdown reader for what the assistant writes.
//
// It returns a plain tree, never HTML: components/Markdown.jsx turns the tree into React
// elements, so a model that writes `<img src=x onerror=...>` or `<script>` gets those characters
// shown as text and nothing else. There is no innerHTML anywhere on this path.
//
// Only the handful of things a coach actually writes are understood: paragraphs, headings (shown
// as a bold line), bullet and numbered lists, fenced code, **bold**, *italic*, `code` and links.
// A link is kept only when it is http(s); anything else (javascript:, data:, a relative path)
// is shown as its own text. Tables and everything else fall through as text.

/** @typedef {{ t: 'text'|'b'|'i'|'code'|'a', v?: string, href?: string, c?: any[] }} Inline */

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i

// Longest alternatives first, so ** is read before *.
const INLINE = /(\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+?)`|\*([^*\s][^*\n]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_\n]*?)_(?![A-Za-z0-9])|\[([^\]\n]+?)\]\(([^)\s]+)\))/g

/** @returns {Inline[]} */
export function parseInline(text) {
  const out = []
  let last = 0
  for (const m of String(text).matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
    if (m[2] != null || m[3] != null) out.push({ t: 'b', c: parseInline(m[2] ?? m[3]) })
    else if (m[4] != null) out.push({ t: 'code', v: m[4] })
    else if (m[5] != null || m[6] != null) out.push({ t: 'i', c: parseInline(m[5] ?? m[6]) })
    else if (SAFE_URL.test(m[8])) out.push({ t: 'a', href: m[8], c: parseInline(m[7]) })
    else out.push({ t: 'text', v: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

/**
 * Blocks: { t: 'p', c } | { t: 'h', c } | { t: 'ul'|'ol', items: Inline[][] } | { t: 'pre', v }.
 * A line break inside a paragraph is kept as one, because a chat reply is written the way it
 * is read.
 */
export function parseMarkdown(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let para = []
  let list = null
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) })
    para = []
  }
  const close = () => { if (list) blocks.push(list); list = null }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush(); close()
      const code = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
      blocks.push({ t: 'pre', v: code.join('\n') })
      continue
    }
    if (!line.trim()) { flush(); close(); continue }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (h) { flush(); close(); blocks.push({ t: 'h', c: parseInline(h[1].replace(/\s+#+\s*$/, '')) }); continue }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line)
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      if (!list || list.t !== kind) { close(); list = { t: kind, items: [] } }
      list.items.push(parseInline((ul || ol)[1]))
      continue
    }
    // A continuation of the last list item, indented under it.
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1].push({ t: 'text', v: ' ' }, ...parseInline(line.trim())); continue }
    close()
    para.push(line)
  }
  flush(); close()
  return blocks
}
