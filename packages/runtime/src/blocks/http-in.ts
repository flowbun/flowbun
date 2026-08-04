import { defineBlock } from "../block";
import type {
  HttpInChunk,
  HttpInConfig,
  HttpInReply,
  HttpInRequest,
} from "../http/in";
import { answerHttpRequest, startHttpIn, streamHttpChunk } from "../http/in";

/**
 * The block definition itself — see hass-trigger.ts's own doc comment on why
 * this lives here, separate from ../http/in.ts's real logic.
 *
 * The first `kind: "duplex"` block (see block.ts's DuplexBlockDef doc
 * comment): subscribe() opens the real listener inside this node's own
 * Worker — the flow's process, never the coordinator — and every accepted
 * request is emitted out the `request` port while its HTTP response is held
 * open. Wiring any message carrying the same `requestId` back into the
 * `reply` input completes that response; if the flow never answers,
 * ../http/in.ts's own reply timeout answers 504 so the caller is never left
 * hanging on a broken flow.
 */
export default defineBlock<
  HttpInConfig,
  { reply: HttpInReply; chunk: HttpInChunk },
  { request: HttpInRequest }
>({
  name: "@http/in",
  kind: "duplex",
  config: {
    port: 8130,
    hostname: "0.0.0.0",
    path: "",
    token: "",
    replyTimeoutMs: 30_000,
  },
  inputs: { reply: {} as HttpInReply, chunk: {} as HttpInChunk },
  outputs: { request: {} as HttpInRequest },
  async subscribe(ctx, emit) {
    const { stop } = await startHttpIn(ctx.config, ctx.log, (request) =>
      emit("request", request),
    );
    return stop;
  },
  async process(inputs, ctx) {
    if (inputs.chunk !== undefined) {
      // A chunk racing the final answer/timeout is an expected, harmless
      // race — debug, not warn, unlike an unmatched final reply below.
      if (!streamHttpChunk(inputs.chunk)) {
        ctx.log.debug("http_in.chunk_after_close", {
          requestId: inputs.chunk.requestId,
        });
      }
      return;
    }
    const reply = inputs.reply;
    if (!answerHttpRequest(reply)) {
      ctx.log.warn("http_in.unknown_request_id", {
        requestId: reply.requestId,
      });
    }
  },
});
