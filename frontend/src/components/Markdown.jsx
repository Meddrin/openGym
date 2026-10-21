// The assistant's prose, as React elements. See lib/markdown.js: the parse returns a tree, and
// this only ever creates elements and text nodes, so nothing the model writes can become markup.
import { parseMarkdown } from '../lib/markdown.js'

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    if (n.t === 'b') return <strong key={i}><Inline nodes={n.c} /></strong>
    if (n.t === 'i') return <em key={i}><Inline nodes={n.c} /></em>
    if (n.t === 'code') return <code key={i}>{n.v}</code>
    if (n.t === 'a') return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow"><Inline nodes={n.c} /></a>
    return n.v
  })
}

export default function Markdown({ text }) {
  const blocks = parseMarkdown(text)
  return <div className="md">
    {blocks.map((b, i) => {
      if (b.t === 'ul') return <ul key={i}>{b.items.map((it, k) => <li key={k}><Inline nodes={it} /></li>)}</ul>
      if (b.t === 'ol') return <ol key={i}>{b.items.map((it, k) => <li key={k}><Inline nodes={it} /></li>)}</ol>
      if (b.t === 'pre') return <pre key={i}>{b.v}</pre>
      if (b.t === 'h') return <p key={i} className="md-h"><strong><Inline nodes={b.c} /></strong></p>
      return <p key={i}><Inline nodes={b.c} /></p>
    })}
  </div>
}
