interface VisibleToolCall { function: { name: string; arguments: string } }
interface VisibleMessage {
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_calls?: VisibleToolCall[];
  name?: string;
}
export interface VisibleOutput { text?: string; toolCalls?: VisibleToolCall[] }

/** A character heuristic over client-visible context, NOT billing or model-token telemetry.
 * Retries, server history and hidden reasoning cannot be measured here. */
export function estimateVisibleUsage(messages: VisibleMessage[], tools: unknown, output: VisibleOutput): Record<string, unknown> & { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const modalities = new Set<string>();
  const textOnly = (text: string): string => text.replace(/data:image\/[^\s)]+/g, () => { modalities.add("image"); return ""; });
  const callsText = (calls: VisibleToolCall[] = []) => calls.map(call => call.function.name + call.function.arguments).join("");
  let input = "";
  for (const message of messages) {
    input += message.name ?? "";
    if (typeof message.content === "string") input += textOnly(message.content);
    else for (const part of message.content ?? []) {
      if (part.type === "text") input += textOnly(part.text ?? "");
      else modalities.add(part.type === "image_url" ? "image" : part.type);
    }
    input += callsText(message.tool_calls);
  }
  if (tools && Array.isArray(tools) && tools.length) input += JSON.stringify(tools);
  const emitted = textOnly(output.text ?? "") + callsText(output.toolCalls);
  const prompt_tokens = Math.ceil(Array.from(input).length / 4);
  const completion_tokens = Math.ceil(Array.from(emitted).length / 4);
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens,
    x_m365_usage_estimated: true, x_m365_usage_basis: "visible_context_chars_div_4",
    ...(modalities.size ? { x_m365_usage_unestimated_modalities: [...modalities].sort() } : {}),
  };
}
