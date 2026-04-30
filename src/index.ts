import type { Plugin } from "@opencode-ai/plugin";
import { writeFileSync } from "fs";

type Turn = {
  parts: any[];
  finish: any | null;
  timestamp: number | undefined;
};

let _sessionId: string | undefined;
const _turns: Turn[] = [];
let _currentTurn: Turn | null = null;
const _userMessages: { text: string; timestamp: number | undefined }[] = [];

// https://github.com/harbor-framework/harbor/commit/67520896b28db9b0b21ed64eac9501b1e5c7138c
// Per-event ingest: groups events into turns by step_start & step_finish (harbor based)
function toAtif(event: { type: string; timestamp: number; [k: string]: any }) {
  if (!_sessionId && event.part?.sessionID) _sessionId = event.part.sessionID;

  if (event.type === "user_message") {
    const text = event.part?.text;
    if (text) {
      _userMessages.push({ text, timestamp: event.timestamp });
    }
    return;
  }

  if (event.type === "step_start") {
    _currentTurn = { parts: [], finish: null, timestamp: event.timestamp };
    return;
  }

  if (event.type === "step_finish") {
    if (_currentTurn) {
      _currentTurn.finish = event.part ?? {};
      _turns.push(_currentTurn);
      _currentTurn = null;
    }
    return;
  }

  if (
    _currentTurn &&
    (event.type === "text" ||
      event.type === "tool_use" ||
      event.type === "reasoning")
  ) {
    _currentTurn.parts.push(event.part ?? {});
  }
}

function finalizeAtif(
  opts: { modelName?: string; agentVersion?: string } = {},
) {
  const steps: any[] = [];
  let stepId = 1;
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;

  for (const um of _userMessages) {
    const userStep: any = {
      step_id: stepId++,
      source: "user",
      message: um.text,
    };
    if (um.timestamp) userStep.timestamp = new Date(um.timestamp).toISOString();
    steps.push(userStep);
  }

  for (const turn of _turns) {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: any[] = [];
    const observationResults: any[] = [];
    const timestamp = turn.timestamp
      ? new Date(turn.timestamp).toISOString()
      : undefined;

    for (const part of turn.parts) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "reasoning" && part.text) {
        reasoningParts.push(part.text);
      } else if (part.type === "tool") {
        const state = part.state ?? {};
        const callId = part.callID ?? part.id ?? "";
        const rawInput = state.input;
        const toolInput =
          rawInput && typeof rawInput === "object"
            ? rawInput
            : rawInput
              ? { value: rawInput }
              : {};
        toolCalls.push({
          tool_call_id: callId,
          function_name: part.tool ?? "",
          arguments: toolInput,
        });
        if (state.output != null) {
          observationResults.push({
            source_call_id: callId || null,
            content: String(state.output),
          });
        } else if (state.error) {
          observationResults.push({
            source_call_id: callId || null,
            content: String(state.error),
            extra: { error: true, status: state.status },
          });
        }
      }
    }

    const finish = turn.finish ?? {};
    const tokens = finish.tokens ?? {};
    const cost = finish.cost ?? 0;
    const inputTok = tokens.input ?? 0;
    const outputTok = tokens.output ?? 0;
    const reasoningTok = tokens.reasoning ?? 0;
    const cache = tokens.cache ?? {};
    const cacheRead = cache.read ?? 0;
    const cacheWrite = cache.write ?? 0;

    totalCost += cost;
    totalInputTokens += inputTok + cacheRead;
    totalOutputTokens += outputTok;
    totalCacheRead += cacheRead;

    let metrics: any;
    if (inputTok || outputTok || cacheRead) {
      metrics = {
        prompt_tokens: inputTok + cacheRead,
        completion_tokens: outputTok,
      };
      if (cacheRead) metrics.cached_tokens = cacheRead;
      if (cost) metrics.cost_usd = cost;
      const extra: Record<string, number> = {};
      if (reasoningTok) extra.reasoning_tokens = reasoningTok;
      if (cacheWrite) extra.cache_write_tokens = cacheWrite;
      if (Object.keys(extra).length) metrics.extra = extra;
    }

    const step: any = {
      step_id: stepId++,
      source: "agent",
      message: textParts.join("\n") || "(tool use)",
    };
    if (timestamp) step.timestamp = timestamp;
    if (opts.modelName) step.model_name = opts.modelName;
    if (reasoningParts.length)
      step.reasoning_content = reasoningParts.join("\n");
    if (toolCalls.length) step.tool_calls = toolCalls;
    if (observationResults.length)
      step.observation = { results: observationResults };
    if (metrics) step.metrics = metrics;

    steps.push(step);
  }

  if (!steps.length) return null;

  return {
    schema_version: "ATIF-v1.7",
    session_id: _sessionId,
    agent: {
      name: "opencode",
      version: opts.agentVersion ?? "unknown",
      model_name: opts.modelName,
    },
    steps,
    final_metrics: {
      total_prompt_tokens: totalInputTokens || undefined,
      total_completion_tokens: totalOutputTokens || undefined,
      total_cached_tokens: totalCacheRead || undefined,
      total_cost_usd: totalCost || undefined,
      total_steps: steps.length,
    },
  };
}

export const AtifTracesPlugin: Plugin = async (ctx) => {
  const path = process.env.ATIF;
  if (!path) return {};

  let pinnedSessionID: string | undefined;
  let modelName: string | undefined;
  let agentVersion: string | undefined;
  const userMessageIds = new Set<string>();
  const emittedUserIds = new Set<string>();

  let flushed = false;
  const flush = () => {
    if (flushed) return;
    flushed = true;
    const trajectory = finalizeAtif({ modelName, agentVersion });
    if (trajectory) {
      writeFileSync(path, JSON.stringify(trajectory, null, 2));
    }
  };
  process.on("beforeExit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);

  function emit(type: string, data: Record<string, unknown>) {
    toAtif({ type, timestamp: Date.now(), ...data });
  }

  // OpenCode JSON formatter
  // https://github.com/anomalyco/opencode/blob/62e1335388fdbadaa95d258b43f1c84740e6db1d/packages/opencode/src/cli/cmd/run.ts#L420-L553
  return {
    event: async ({ event }) => {
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "user") {
          userMessageIds.add(info.id);
        } else if (info.role === "assistant") {
          if (!modelName && info.modelID) modelName = info.modelID;
        }
      }

      if (event.type === "session.updated") {
        const info = event.properties.info;
        if (!agentVersion && info?.version) agentVersion = info.version;
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part;

        // TODO(cristian): Don't do this. Support concurrent OpenCode runs
        if (!pinnedSessionID) pinnedSessionID = part.sessionID;
        if (part.sessionID !== pinnedSessionID) return;

        if (
          part.type === "text" &&
          userMessageIds.has(part.messageID) &&
          !emittedUserIds.has(part.messageID)
        ) {
          emittedUserIds.add(part.messageID);
          emit("user_message", { part });
          return;
        }

        if (
          part.type === "tool" &&
          (part.state.status === "completed" || part.state.status === "error")
        ) {
          emit("tool_use", { part });
        }

        if (part.type === "step-start") {
          emit("step_start", { part });
        }

        if (part.type === "step-finish") {
          emit("step_finish", { part });
        }

        if (part.type === "text" && part.time?.end) {
          emit("text", { part });
        }

        if (part.type === "reasoning" && part.time?.end) {
          emit("reasoning", { part });
        }
      }

      if (event.type === "session.error") {
        emit("error", { error: event.properties.error });
      }

      if (event.type === "session.idle") {
        flush();
      }
    },
  };
};
