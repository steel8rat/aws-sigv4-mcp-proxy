/** A single parsed Server-Sent Events record. */
export interface SseEvent {
  event?: string;
  data?: string;
  id?: string;
  retry?: number;
}

/**
 * Incrementally parse an SSE byte stream (as produced by a `fetch` response body)
 * into events, yielding each one as soon as its terminating blank line arrives.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fields: SseEvent = {};
  let dataLines: string[] = [];

  const take = (): SseEvent | null => {
    if (dataLines.length === 0 && fields.event === undefined && fields.id === undefined && fields.retry === undefined) {
      return null;
    }
    const event: SseEvent = { ...fields };
    if (dataLines.length > 0) event.data = dataLines.join("\n");
    fields = {};
    dataLines = [];
    return event;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          const event = take();
          if (event) yield event;
          continue;
        }
        if (line.startsWith(":")) continue; // comment

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);

        switch (field) {
          case "event":
            fields.event = val;
            break;
          case "data":
            dataLines.push(val);
            break;
          case "id":
            fields.id = val;
            break;
          case "retry": {
            const n = Number(val);
            if (Number.isFinite(n)) fields.retry = n;
            break;
          }
        }
      }
    }
    const trailing = take();
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}
