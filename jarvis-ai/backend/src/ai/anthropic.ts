import { ProviderError, type AIProvider, type ChatMsg, type CompleteParams, type CompleteResult } from './types.js';

/** Anthropic Messages API (tool use + vision). */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  constructor(private apiKey: string) {}

  private toWire(msgs: ChatMsg[]) {
    const out: any[] = [];
    const push = (role: 'user' | 'assistant', block: any) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(block); else out.push({ role, content: [block] });
    };
    for (const m of msgs) {
      if (m.role === 'user') {
        m.images?.forEach((i) => push('user', { type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.base64 } }));
        push('user', { type: 'text', text: m.content || '(empty)' });
      } else if (m.role === 'assistant') {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        m.toolCalls?.forEach((t) => push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: t.args }));
      } else push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    }
    return out;
  }

  async complete(p: CompleteParams): Promise<CompleteResult> {
    const body: any = { model: p.model, max_tokens: p.maxTokens ?? 1024, system: p.system, messages: this.toWire(p.messages) };
    if (p.tools?.length) body.tools = p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: p.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError(res.status, `provider ${res.status}`);
    const j: any = await res.json();
    const blocks: any[] = j.content ?? [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
    };
  }
}
