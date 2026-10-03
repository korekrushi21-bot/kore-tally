import { execFile } from 'node:child_process';
import { ProviderError, type AIProvider, type ChatMsg, type CompleteParams, type CompleteResult, type ToolDef } from './types.js';

/** Models likely to run on an ordinary PC, in order of preference (used only if installed). */
export const PREFERRED_MODELS = ['qwen2.5:3b', 'llama3.2:3b', 'qwen2.5:7b', 'llama3.1:8b', 'gemma3:4b', 'gemma3:1b', 'phi3:mini', 'qwen2.5:1.5b', 'llama3.2:1b'];
const VISION_HINT = /(llava|vision|vl\b|qwen2\.5vl|minicpm-v|moondream|bakllava|gemma3|granite3\.2-vision|mistral-small3)/i;
const NOT_CHAT = /(embed|nomic|bge|minilm|rerank)/i;
// gemma3:1b is text-only (the 4b+ variants are multimodal)
export const isVisionModel = (m: string) => VISION_HINT.test(m) && !/gemma3:(1b|270m)/i.test(m);

export interface OllamaStatus {
  baseUrl: string;
  installed: boolean | null; // null = cannot tell (server is remote)
  running: boolean;
  models: { name: string; sizeGB: number; vision: boolean }[];
  version?: string;
}

export function ollamaInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ollama', ['--version'], { timeout: 4000, windowsHide: true }, (err) => resolve(!err));
  });
}

export async function ollamaStatus(baseUrl: string): Promise<OllamaStatus> {
  const base = baseUrl.replace(/\/+$/, '');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(base);
  const out: OllamaStatus = { baseUrl: base, installed: local ? null : null, running: false, models: [] };
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const j: any = await r.json();
      out.running = true;
      out.models = ((j.models ?? []) as any[])
        .filter((m) => !NOT_CHAT.test(m.name))
        .map((m) => ({ name: String(m.name), sizeGB: Math.round(((m.size ?? 0) / 1e9) * 10) / 10, vision: isVisionModel(String(m.name)) }));
      out.installed = true;
      try { out.version = ((await (await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(2000) })).json()) as any).version; } catch { /* optional */ }
      return out;
    }
  } catch { /* not running */ }
  out.installed = local ? await ollamaInstalled() : null;
  return out;
}

/** Pick a model: explicit choice (if installed) > preferred lightweight list > smallest installed. */
export function pickModel(models: OllamaStatus['models'], wanted?: string): string | null {
  if (!models.length) return null;
  if (wanted) {
    const hit = models.find((m) => m.name === wanted) ?? models.find((m) => m.name.split(':')[0] === wanted.split(':')[0] && !wanted.includes(':'));
    if (hit) return hit.name;
  }
  for (const p of PREFERRED_MODELS) { const m = models.find((x) => x.name === p); if (m) return m.name; }
  return [...models].sort((a, b) => a.sizeGB - b.sizeGB)[0].name;
}

const noToolSupport = new Set<string>(); // models that rejected native tool calling

function toolPrompt(tools: ToolDef[]) {
  return `\n\nTOOL USE (this model has no native tool calling): to call a tool, reply with ONLY one or more blocks of the form
<tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>
and nothing else. After the tool results arrive (as "[tool result …]" messages) answer the user normally, WITHOUT tool_call blocks. If no tool is needed, just answer.
Available tools (JSON schema):
${tools.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })).join('\n')}`;
}

function parseToolBlocks(text: string): { text: string; calls: { name: string; args: Record<string, any> }[] } {
  const calls: { name: string; args: Record<string, any> }[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try { const o = JSON.parse(m[1]); if (o?.name) calls.push({ name: String(o.name), args: o.arguments ?? o.args ?? {} }); } catch { /* ignore malformed */ }
  }
  // some models emit bare JSON without tags
  if (!calls.length) {
    const bare = text.trim().match(/^\{[\s\S]*"name"\s*:\s*"[A-Za-z]+"[\s\S]*\}$/);
    if (bare) { try { const o = JSON.parse(bare[0]); if (o?.name && (o.arguments || o.args)) calls.push({ name: String(o.name), args: o.arguments ?? o.args }); } catch { /* ignore */ } }
  }
  return { text: text.replace(re, '').trim(), calls };
}

/** Local AI through Ollama's native /api/chat. Supports native tools, prompt-based tools, and vision. */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  constructor(private baseUrl: string) {}

  private wire(msgs: ChatMsg[], promptTools: boolean) {
    const out: any[] = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content, ...(m.images?.length ? { images: m.images.map((i) => i.base64) } : {}) });
      } else if (m.role === 'assistant') {
        if (promptTools && m.toolCalls?.length) {
          out.push({ role: 'assistant', content: m.toolCalls.map((t) => `<tool_call>${JSON.stringify({ name: t.name, arguments: t.args })}</tool_call>`).join('\n') });
        } else {
          out.push({ role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ function: { name: t.name, arguments: t.args } })) } : {}) });
        }
      } else if (promptTools) {
        out.push({ role: 'user', content: `[tool result for ${m.name}] ${m.content}` });
      } else out.push({ role: 'tool', tool_name: m.name, content: m.content });
    }
    return out;
  }

  private async call(body: any, signal?: AbortSignal) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ProviderError(res.status, /does not support tools/i.test(t) ? 'no_tools' : `ollama ${res.status}`);
    }
    return (await res.json()) as any;
  }

  async complete(p: CompleteParams): Promise<CompleteResult> {
    const hasTools = !!p.tools?.length;
    const options = { num_predict: p.maxTokens ?? 1024, temperature: 0.3 };
    const base = { model: p.model, stream: false, options, ...(p.json ? { format: 'json' } : {}) };

    if (hasTools && !noToolSupport.has(p.model)) {
      try {
        const j = await this.call({ ...base, messages: [{ role: 'system', content: p.system }, ...this.wire(p.messages, false)], tools: p.tools!.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }, p.signal);
        const msg = j.message ?? {};
        return {
          text: msg.content ?? '',
          toolCalls: (msg.tool_calls ?? []).map((t: any, i: number) => ({ id: `call_${Date.now()}_${i}`, name: t.function?.name, args: typeof t.function?.arguments === 'string' ? safeJson(t.function.arguments) : (t.function?.arguments ?? {}) })),
        };
      } catch (e) {
        if (!(e instanceof ProviderError && e.message === 'no_tools')) throw e;
        noToolSupport.add(p.model);
      }
    }

    const promptTools = hasTools;
    const system = promptTools ? p.system + toolPrompt(p.tools!) : p.system;
    const j = await this.call({ ...base, messages: [{ role: 'system', content: system }, ...this.wire(p.messages, promptTools)] }, p.signal);
    const raw: string = j.message?.content ?? '';
    if (!promptTools) return { text: raw, toolCalls: [] };
    const parsed = parseToolBlocks(raw);
    return { text: parsed.text, toolCalls: parsed.calls.map((c, i) => ({ id: `call_${Date.now()}_${i}`, name: c.name, args: c.args })) };
  }
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return {}; } }
