/**
 * WhatsApp Cloud API webhook server.
 *
 * Receives messages via Meta webhook → runs claude CLI → replies via Graph API.
 * Configured via settings.json `whatsapp` block.
 */

import { join } from "path";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import type { WhatsAppConfig } from "./config";
import { run } from "./runner";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
const MAX_HISTORY = 20;

interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export interface WhatsAppServerHandle {
  port: number;
  stop: () => void;
}

function historyFile(projectDir: string): string {
  return join(projectDir, ".claude", "claudeclaw", "whatsapp-history.json");
}

async function loadHistory(projectDir: string): Promise<HistoryEntry[]> {
  const file = historyFile(projectDir);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

async function saveHistory(projectDir: string, history: HistoryEntry[]): Promise<void> {
  await writeFile(historyFile(projectDir), JSON.stringify(history.slice(-MAX_HISTORY), null, 2));
}

async function appendHistory(projectDir: string, role: "user" | "assistant", text: string): Promise<void> {
  const history = await loadHistory(projectDir);
  history.push({ role, text, ts: new Date().toISOString() });
  await saveHistory(projectDir, history);
}

function buildPrompt(userMessage: string, history: HistoryEntry[]): string {
  const lines = [
    "[Bối cảnh: Đây là tin nhắn WhatsApp. Trả lời ngắn gọn, tự nhiên.]",
    "",
  ];
  if (history.length > 0) {
    lines.push("--- Lịch sử gần đây ---");
    for (const h of history.slice(-10)) {
      lines.push(`${h.role === "user" ? "User" : "Claw"}: ${h.text}`);
    }
    lines.push("---", "");
  }
  lines.push(`User: ${userMessage}`);
  return lines.join("\n");
}

async function sendWhatsAppMessage(cfg: WhatsAppConfig, to: string, text: string): Promise<void> {
  const url = `${GRAPH_API_BASE}/${cfg.phoneNumberId}/messages`;
  // Split at 4000 chars to stay within WA's 4096-char limit
  const chunks = text.match(/.{1,4000}/gs) ?? [text];
  for (const chunk of chunks) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk },
      }),
    });
    if (!resp.ok) {
      console.error(`[WhatsApp] Send failed ${resp.status}: ${await resp.text()}`);
    }
  }
}

async function handleMessage(cfg: WhatsAppConfig, projectDir: string, sender: string, text: string): Promise<void> {
  await appendHistory(projectDir, "user", text);
  const history = await loadHistory(projectDir);
  const prompt = buildPrompt(text, history.slice(0, -1));

  const result = await run("whatsapp", prompt, {
    sessionGroup: cfg.sessionGroup,
  });

  const reply = result.exitCode === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : "❌ Lỗi xử lý — check log nhé.";

  await appendHistory(projectDir, "assistant", reply);
  await sendWhatsAppMessage(cfg, sender, reply);
}

export function startWhatsAppServer(cfg: WhatsAppConfig, projectDir: string): WhatsAppServerHandle {
  const server = Bun.serve({
    port: cfg.port,
    hostname: "0.0.0.0",

    async fetch(req) {
      const url = new URL(req.url);
      const isWebhookPath = url.pathname === "/webhook" || url.pathname === "/webhook/whatsapp";

      if (!isWebhookPath) {
        return new Response("Not Found", { status: 404 });
      }

      // Meta webhook verification
      if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && token === cfg.verifyToken && challenge) {
          console.log(`[WhatsApp] Webhook verified by Meta`);
          return new Response(challenge, { headers: { "Content-Type": "text/plain" } });
        }
        return new Response("Forbidden", { status: 403 });
      }

      // Incoming message
      if (req.method === "POST") {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        try {
          const entry = body?.entry?.[0]?.changes?.[0]?.value;
          const messages: any[] = entry?.messages ?? [];

          for (const msg of messages) {
            const sender: string = msg?.from ?? "";
            if (sender !== cfg.allowedSender) {
              console.warn(`[WhatsApp] Blocked sender: ${sender}`);
              continue;
            }

            let text: string;
            if (msg.type === "text") {
              text = msg.text?.body ?? "";
            } else if (msg.type === "audio") {
              text = "[Voice message — nhắn text nhé]";
            } else {
              text = `[${msg.type} message]`;
            }

            console.log(`[WhatsApp] Message from ${sender}: ${text.slice(0, 80)}`);
            // Fire-and-forget so Meta gets 200 immediately
            handleMessage(cfg, projectDir, sender, text).catch((err) =>
              console.error(`[WhatsApp] Error processing message:`, err)
            );
          }
        } catch (err) {
          console.error(`[WhatsApp] Payload parse error:`, err);
        }

        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    },
  });

  console.log(`[WhatsApp] Webhook server listening on port ${server.port}`);
  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
