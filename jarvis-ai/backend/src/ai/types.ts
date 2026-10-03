export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, any> }
export interface Image { base64: string; mimeType: string }

export type ChatMsg =
  | { role: 'user'; content: string; images?: Image[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface CompleteParams { system: string; messages: ChatMsg[]; tools?: ToolDef[]; model: string; maxTokens?: number; json?: boolean; signal?: AbortSignal }
export interface CompleteResult { text: string; toolCalls: ToolCall[] }

export interface AIProvider {
  readonly name: string;
  complete(p: CompleteParams): Promise<CompleteResult>;
}

export class ProviderError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
