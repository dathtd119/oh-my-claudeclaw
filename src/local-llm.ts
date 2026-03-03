/**
 * Local LLM client for lightweight tasks (classification, translation, etc.)
 * Uses llama-swap at localhost:9292 (OpenAI-compatible endpoint).
 * Falls back to null on failure — caller handles fallback to Haiku.
 */

const DEFAULT_URL = "http://localhost:9292/v1/chat/completions";
const DEFAULT_MODEL = "qwen-2b";
const DEFAULT_TIMEOUT = 10_000;

interface LocalLlmConfig {
  url?: string;
  model?: string;
  timeout?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let config: LocalLlmConfig = {};

export function setLocalLlmConfig(cfg: LocalLlmConfig): void {
  config = cfg;
}

export async function localLlmChat(
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number },
): Promise<string | null> {
  const url = config.url || DEFAULT_URL;
  const model = config.model || DEFAULT_MODEL;
  const timeout = config.timeout || DEFAULT_TIMEOUT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options?.maxTokens ?? 100,
        temperature: options?.temperature ?? 0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[local-llm] HTTP ${res.status}: ${res.statusText}`);
      return null;
    }

    const json = await res.json() as any;
    const content = json.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : null;
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.warn(`[local-llm] Timeout after ${timeout}ms`);
    } else {
      console.warn(`[local-llm] Error: ${err.message ?? err}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
