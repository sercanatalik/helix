/* helix-ai · Server-Sent Events parser for streaming chat completions.
 *
 * Implements just enough of the SSE spec to consume an OpenAI-compatible
 * `/chat/completions` stream: events delimited by blank lines, lines
 * starting with `data:` carrying the payload, and a literal `[DONE]`
 * sentinel ending the stream. Comment lines (starting with `:`), unknown
 * fields, and malformed JSON are skipped silently — providers (LiteLLM,
 * Ollama, etc.) routinely emit keep-alive pings or non-standard metadata
 * that we don't want to crash on. */

import type { ChatCompletionChunk } from "./types";

export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatCompletionChunk, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line. Some providers use \r\n.
      let sep = findEventBoundary(buffer);
      while (sep !== -1) {
        const rawEvent = buffer.slice(0, sep.start);
        buffer = buffer.slice(sep.end);
        const data = extractData(rawEvent);
        if (data === null) {
          sep = findEventBoundary(buffer);
          continue;
        }
        if (data === "[DONE]") return;
        const chunk = tryParseChunk(data);
        if (chunk) yield chunk;
        sep = findEventBoundary(buffer);
      }
    }

    // Flush a trailing event without a closing blank line — some Ollama
    // builds end the stream this way.
    const tail = buffer.trim();
    if (tail) {
      const data = extractData(tail);
      if (data && data !== "[DONE]") {
        const chunk = tryParseChunk(data);
        if (chunk) yield chunk;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface Boundary {
  readonly start: number;
  readonly end: number;
}

/** Locate the next `\n\n` (or `\r\n\r\n`) boundary, returning the slice
 * indices the caller should use. Returning -1 means "no complete event yet". */
function findEventBoundary(buf: string): Boundary | -1 {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) {
    return { start: lf, end: lf + 2 };
  }
  return { start: crlf, end: crlf + 4 };
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataParts: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const v = line.slice(5);
      // Per SSE spec a single leading space after the colon is stripped.
      dataParts.push(v.startsWith(" ") ? v.slice(1) : v);
    }
    // Other fields (event:, id:, retry:) are ignored.
  }
  return dataParts.length > 0 ? dataParts.join("\n") : null;
}

function tryParseChunk(data: string): ChatCompletionChunk | null {
  try {
    return JSON.parse(data) as ChatCompletionChunk;
  } catch {
    return null;
  }
}
