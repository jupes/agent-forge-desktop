type CdpMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  error?: unknown;
  result?: unknown;
};

export function openCdp(url: string): Promise<WebSocket> {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(url);
    const onOpen = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("error", onError);
      resolveSocket(socket);
    };
    const onError = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      reject(new Error("WebView debug connection failed."));
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.close();
      reject(new Error("WebView debug connection timed out."));
    }, 5_000);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

export async function cdpEnable(socket: WebSocket): Promise<void> {
  await cdp(socket, "Runtime.enable", {});
  await cdp(socket, "Log.enable", {});
  await cdp(socket, "Page.enable", {});
}

export async function evaluate(
  socket: WebSocket,
  expression: string,
): Promise<unknown> {
  const result = await cdp(socket, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined)
    throw new Error("WebView evaluation failed.");
  return asRecord(result.result)?.value;
}

let nextCommandId = 1;
export function cdp(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = nextCommandId++;
  return new Promise((resolveResult, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const message = parseCdpMessage(String(event.data));
      if (message?.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error !== undefined)
        reject(new Error("WebView command failed."));
      else resolveResult(asRecord(message.result) ?? {});
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("WebView command timed out."));
    }, 5_000);
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

export function parseCdpMessage(raw: string): CdpMessage | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    const record = asRecord(value);
    return record as CdpMessage | undefined;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
