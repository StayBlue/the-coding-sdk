import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type ElicitationHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export class McpBridgeTransport implements McpTransport {
  #sendToCli: (message: JSONRPCMessage) => void;
  #onElicitation: ElicitationHandler | undefined;
  #closed = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(sendToCli: (message: JSONRPCMessage) => void, onElicitation?: ElicitationHandler) {
    this.#sendToCli = sendToCli;
    this.#onElicitation = onElicitation;
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new Error("Transport is closed");

    if (
      "method" in message &&
      message.method === "elicitation/create" &&
      "id" in message &&
      message.id != null
    ) {
      void this.#handleElicitation(message);
      return;
    }

    this.#sendToCli(message);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }

  handleInbound(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }

  async #handleElicitation(
    message: JSONRPCMessage & { id: string | number; params?: unknown },
  ): Promise<void> {
    try {
      if (!this.#onElicitation) {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: { action: "decline" },
        } as JSONRPCMessage);
        return;
      }

      const params = (message.params ?? {}) as Record<string, unknown>;
      const result = await this.#onElicitation(params);
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result,
      } as JSONRPCMessage);
    } catch {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: { action: "cancel" },
      } as JSONRPCMessage);
    }
  }
}
