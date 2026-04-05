/*
 * Copyright 2026 StayBlue
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { parseMcpElicitationCreateRequest, parseRecordUnknown } from "./schemas.ts";

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

    const elicitationRequest = parseMcpElicitationCreateRequest(message);
    if (elicitationRequest) {
      void this.#handleElicitation(elicitationRequest);
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

  async #handleElicitation(message: {
    method: "elicitation/create";
    id: string | number;
    params?: unknown;
  }): Promise<void> {
    try {
      if (!this.#onElicitation) {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: { action: "decline" },
        } as JSONRPCMessage);
        return;
      }

      const params = parseRecordUnknown(message.params) ?? {};
      const result = await this.#onElicitation(params);
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result,
      } as JSONRPCMessage);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.onmessage?.({
        jsonrpc: "2.0",
        id: message.id,
        result: { action: "cancel" },
      } as JSONRPCMessage);
    }
  }
}
