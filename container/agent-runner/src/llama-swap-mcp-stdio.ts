/**
 * llama-swap MCP Server for NanoClaw
 * Exposes local llama-swap models as tools for the container agent.
 * llama-swap provides an OpenAI-compatible API in front of llama.cpp instances.
 * Uses host.docker.internal to reach the host from Docker.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LLAMA_SWAP_HOST = process.env.LLAMA_SWAP_HOST || 'http://host.docker.internal:8080';

function log(msg: string): void {
  console.error(`[LLAMA-SWAP] ${msg}`);
}

async function llamaFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${LLAMA_SWAP_HOST}${path}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (LLAMA_SWAP_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}

const server = new McpServer({
  name: 'llama-swap',
  version: '1.0.0',
});

server.tool(
  'llama_list_models',
  'List all models available on the local llama-swap server. Use this to see which models are available before calling llama_chat.',
  {},
  async () => {
    log('Listing models...');
    try {
      const res = await llamaFetch('/v1/models');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `llama-swap API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }

      const data = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
      const models = data.data || [];

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No models available on llama-swap.' }] };
      }

      const list = models
        .map(m => `- ${m.id}`)
        .join('\n');

      log(`Found ${models.length} models`);
      return { content: [{ type: 'text' as const, text: `Available models:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to llama-swap at ${LLAMA_SWAP_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'llama_chat',
  'Send a chat completion request to a local llama-swap model. Good for cheaper/faster tasks like summarization, translation, coding, or general queries. Use llama_list_models first to see available models.',
  {
    model: z.string().describe('The model name from llama_list_models'),
    messages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })).describe('Chat messages array (OpenAI format)'),
    temperature: z.number().optional().describe('Sampling temperature (0.0-2.0, default server setting)'),
    max_tokens: z.number().optional().describe('Maximum tokens to generate'),
  },
  async (args) => {
    log(`>>> Chat with ${args.model} (${args.messages.length} messages)...`);
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        messages: args.messages,
        stream: false,
      };
      if (args.temperature !== undefined) body.temperature = args.temperature;
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;

      const res = await llamaFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `llama-swap error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        choices?: Array<{ message?: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const responseText = data.choices?.[0]?.message?.content || '';

      let meta = '';
      if (data.usage) {
        meta = `\n\n[${args.model} | ${data.usage.prompt_tokens}+${data.usage.completion_tokens} tokens]`;
        log(`<<< Done: ${args.model} | ${data.usage.total_tokens} tokens | ${responseText.length} chars`);
      } else {
        log(`<<< Done: ${args.model} | ${responseText.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: responseText + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call llama-swap: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'llama_complete',
  'Send a raw text completion request to a local llama-swap model. Use for fill-in-the-middle, code completion, or when you need raw completions instead of chat format.',
  {
    model: z.string().describe('The model name from llama_list_models'),
    prompt: z.string().describe('The text prompt to complete'),
    temperature: z.number().optional().describe('Sampling temperature (0.0-2.0)'),
    max_tokens: z.number().optional().describe('Maximum tokens to generate'),
  },
  async (args) => {
    log(`>>> Complete with ${args.model} (${args.prompt.length} chars)...`);
    try {
      const body: Record<string, unknown> = {
        model: args.model,
        prompt: args.prompt,
        stream: false,
      };
      if (args.temperature !== undefined) body.temperature = args.temperature;
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;

      const res = await llamaFetch('/v1/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `llama-swap error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        choices?: Array<{ text: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const responseText = data.choices?.[0]?.text || '';

      let meta = '';
      if (data.usage) {
        meta = `\n\n[${args.model} | ${data.usage.prompt_tokens}+${data.usage.completion_tokens} tokens]`;
        log(`<<< Done: ${args.model} | ${data.usage.total_tokens} tokens | ${responseText.length} chars`);
      } else {
        log(`<<< Done: ${args.model} | ${responseText.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: responseText + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call llama-swap: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
