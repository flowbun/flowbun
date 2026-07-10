import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "flowbun/ws";

/** Minimal structural shape of the content blocks inside an SDKMessage's
 * `.message.content` — deliberately not importing the SDK's deep
 * beta-namespace block types (BetaTextBlock/BetaToolUseBlock/
 * BetaToolResultBlockParam live several re-exports deep in
 * @anthropic-ai/sdk's beta messages module) since only a handful of fields
 * are actually read here; duck-typing keeps this file decoupled from that
 * internal layout. */
interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: string | Array<{ type: string; text?: string }>;
}
type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string };

function toolResultText(content: ToolResultBlock["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Strips the "mcp__flowbun__" prefix every one of our tools' fully
 * qualified name carries, and renders a short, human-readable summary of
 * its arguments — never the raw args dump, which would be noisy for a
 * chat transcript. */
function summarizeToolUse(name: string, input: unknown): string {
  const shortName = name.replace(/^mcp__flowbun__/, "");
  const args = (input ?? {}) as Record<string, unknown>;
  switch (shortName) {
    case "wiring_mutate": {
      const mutation = args.mutation as { op?: string } | undefined;
      return `wiring_mutate: ${mutation?.op ?? "?"} in ${args.file ?? "?"}`;
    }
    case "block_write":
    case "block_delete":
    case "block_read":
    case "flow_delete":
    case "flow_read":
      return `${shortName}: ${args.file ?? "?"}`;
    case "block_create":
    case "flow_create":
      return `${shortName}: ${args.name ?? "?"}`;
    default:
      return shortName;
  }
}

/**
 * Translates one raw Claude Agent SDK stream message into zero or more
 * flowbun ChatEvents — a small, purpose-built set (see protocol.ts), not a
 * passthrough of the SDK's much larger message union, which the browser
 * has no business knowing about. Pure function: no I/O, fully unit
 * testable against plain object literals shaped like SDKMessage.
 */
export function translateSdkMessage(
  msg: SDKMessage,
  turnId: string,
): ChatEvent[] {
  switch (msg.type) {
    case "assistant": {
      const events: ChatEvent[] = [];
      const blocks = msg.message.content as unknown as ContentBlock[];
      for (const block of blocks) {
        if (block.type === "text") {
          events.push({
            kind: "assistant.text",
            turnId,
            text: (block as TextBlock).text,
          });
        } else if (block.type === "tool_use") {
          const toolUse = block as ToolUseBlock;
          events.push({
            kind: "tool.started",
            turnId,
            toolCallId: toolUse.id,
            summary: summarizeToolUse(toolUse.name, toolUse.input),
          });
        }
      }
      return events;
    }
    case "user": {
      const content = msg.message.content;
      if (typeof content === "string") return [];
      const events: ChatEvent[] = [];
      for (const block of content as unknown as ContentBlock[]) {
        if (block.type === "tool_result") {
          const result = block as ToolResultBlock;
          const text = toolResultText(result.content);
          events.push({
            kind: "tool.finished",
            turnId,
            toolCallId: result.tool_use_id,
            ok: !result.is_error,
            summary: result.is_error ? undefined : text,
            error: result.is_error ? text : undefined,
          });
        }
      }
      return events;
    }
    case "result": {
      if (msg.subtype === "success") {
        return [
          {
            kind: "turn.done",
            turnId,
            ok: true,
            costUsd: msg.total_cost_usd,
            durationMs: msg.duration_ms,
          },
        ];
      }
      return [
        {
          kind: "turn.error",
          turnId,
          reason: msg.subtype === "error_max_turns" ? "max_turns" : "other",
          message: msg.errors?.join("; ") || msg.subtype,
        },
      ];
    }
    default:
      return [];
  }
}
