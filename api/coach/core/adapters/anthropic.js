/* Anthropic Messages API.
 *
 * Besides one-shot calls it runs the assistant's tool loop: the model asks for a tool, the
 * server runs it against the one profile the job is bound to (assistant/tools.js), the result
 * goes back as a tool_result, and the loop ends when the model answers in text. The loop is
 * ours rather than the SDK's, so it has the same shape as the Claude Agent SDK adapter's: only
 * the openGym tools exist, a turn budget, one overall timeout.
 */
import { httpAdapter } from './http.js';
import { jsonSchema, resultText } from '../../assistant/tools.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const MAX_TURNS = 12;

export const anthropicSpec = {
  id: 'anthropic',
  path: () => '/v1/messages',
  modelsPath: '/v1/models',
  headers: key => ({
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    // Required for a call made from a browser context. Harmless from a server, and the phone's
    // native HTTP path does not need it either — it is here so a plain-browser dev run works.
    'anthropic-dangerous-direct-browser-access': 'true'
  }),
  // The rules block is marked cacheable: identical for every job, so subsequent jobs read it
  // from Anthropic's prompt cache at a tenth of the input price.
  body: ({ model, prompt, system, maxTokens }) => ({
    model,
    max_tokens: maxTokens,
    ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
    messages: [{ role: 'user', content: prompt }]
  }),
  errorMessage: data => data && data.error && data.error.message,
  readText: data => {
    if (data.stop_reason === 'refusal') return { error: 'the model declined this request' + (data.stop_details && data.stop_details.explanation ? ': ' + data.stop_details.explanation : '') };
    const text = (data.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
    return { text, truncated: data.stop_reason === 'max_tokens' };
  },
  readModels: data => (data.data || []).map(m => m.id)
};

const base = httpAdapter(anthropicSpec);

/** The tool loop. `toolset` is the job's (assistant/tools.js); `base.exchange` is the transport. */
async function toolLoop(opts) {
  const { prompt, system, tools, maxTokens = 4096, timeoutMs = 5 * 60000 } = opts;
  const started = Date.now();
  const messages = [{ role: 'user', content: prompt }];
  const defs = tools.tools.map(t => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.params) }));
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return { code: -1, text: '', stderr: 'timed out', timedOut: true };
    const r = await base.exchange({ ...opts, timeoutMs: left }, model => ({
      model, max_tokens: maxTokens,
      ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
      tools: defs, messages
    }));
    if (r.code !== 0) return r;
    const data = r.data;
    if (data.stop_reason === 'refusal') return { code: 1, text: '', stderr: 'the model declined this request' };
    const content = Array.isArray(data.content) ? data.content : [];
    const uses = content.filter(b => b && b.type === 'tool_use');
    if (!uses.length || data.stop_reason !== 'tool_use') {
      if (data.stop_reason === 'max_tokens') return { code: 1, text: '', stderr: 'the answer was cut off at the output limit' };
      const text = content.filter(b => b && b.type === 'text').map(b => b.text).join('').trim();
      return text ? { code: 0, text, stderr: '' } : { code: 1, text: '', stderr: 'the model returned no answer' };
    }
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: uses.map(u => {
        const out = tools.call(u.name, u.input && typeof u.input === 'object' ? u.input : {});
        return { type: 'tool_result', tool_use_id: u.id, content: resultText(out), ...(out && (out.error || out.ok === false) ? { is_error: true } : {}) };
      })
    });
  }
  return { code: 1, text: '', stderr: 'the assistant used up its turns without answering' };
}

export default {
  ...base,
  /** Whether invoke can run the assistant's tool loop. */
  tools: true,
  invoke: opts => (opts && opts.tools ? toolLoop(opts) : base.invoke(opts))
};
