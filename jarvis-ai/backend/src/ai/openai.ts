import { ProviderError, type AIProvider, type ChatMsg, type CompleteParams, type CompleteResult } from './types.js';

/** OpenAI Chat Completions. Also used for any OpenAI-compatible server (Custom provider) via baseUrl. */
export class OpenAIProvider implements AIProvider {
  constructor(public readonly name: string, private apiKey: string, private baseUrl = 'https://api.openai.com/v1') {}

  private toWire(system: string, msgs: ChatMsg[]) {
    const out: any[] = [{ role: 'system', content: system }];
    for (const m of msgs) {
      if (m.role === 'user') {
        out.push({
          role: 'user',
          content: m.images?.length
            ? [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.base64}` } }))]
            : m.content,
        });
      } else if (m.role === 'assistant') {
        out.push({
          role: 'assistant', content: m.content || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
        });
      } else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
    return out;
  }

  async complete(p: CompleteParams): Promise<CompleteResult> {
    const body: any = { model: p.model, messages: this.toWire(p.system, p.messages), max_tokens: p.maxTokens ?? 1024 };
    if (p.tools?.length) body.tools = p.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (p.json) body.response_format = { type: 'json_object' };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', signal: p.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError(res.status, `provider ${res.status}`);
    const j: any = await res.json();
    const msg = j.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((t: any) => {
        let args = {}; try { args = JSON.parse(t.function.arguments || '{}'); } catch { /* malformed args -> empty */ }
        return { id: t.id, name: t.function.name, args };
      }),
    };
  }
}
