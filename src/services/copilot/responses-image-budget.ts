import type {
  ResponseInputContent,
  ResponseInputItem,
  ResponsesPayload,
} from "~/lib/types/responses"

import { HTTPError } from "~/lib/error"

// Copilot Responses rejects the whole request above this count. Its model
// catalog currently reports max_prompt_images=1 even when 50 are accepted;
// this is a route-specific guard, not a universal OpenAI/model limit.
export const COPILOT_RESPONSES_IMAGE_LIMIT = 50
export const OMITTED_HISTORY_IMAGE_TEXT =
  "[Historical image omitted from this request to fit the upstream image limit. Do not infer its contents; ask for the original image again if needed.]"

const imageContent = (item: ResponseInputItem) => {
  if ("role" in item && "content" in item && Array.isArray(item.content)) {
    return {
      key: "content" as const,
      blocks: item.content as ResponseInputContent[],
    }
  }
  if (
    (item.type === "function_call_output"
      || item.type === "custom_tool_call_output")
    && Array.isArray(item.output)
  ) {
    return {
      key: "output" as const,
      blocks: item.output,
    }
  }
  return undefined
}

/** Copy-on-write request projection; never edit stored history or image bytes. */
export const budgetCopilotResponseImages = (payload: ResponsesPayload) => {
  if (!Array.isArray(payload.input)) return { payload, omitted: 0 }
  const input = payload.input
  const imageCounts = input.map(
    (item) =>
      imageContent(item)?.blocks.filter((block) => block.type === "input_image")
        .length ?? 0,
  )
  const total = imageCounts.reduce((sum, count) => sum + count, 0)
  let remaining = total - COPILOT_RESPONSES_IMAGE_LIMIT
  if (remaining <= 0) return { payload, omitted: 0 }

  // Everything from the most recent user message belongs to the active turn,
  // including image-bearing tool results. Without a user boundary, fail closed.
  const currentTurnStart = input.findLastIndex(
    (item) => "role" in item && item.role === "user",
  )
  const historicalCount = imageCounts
    .slice(0, Math.max(0, currentTurnStart))
    .reduce((sum, count) => sum + count, 0)
  if (historicalCount < remaining) {
    const message = `The current turn contains more than ${COPILOT_RESPONSES_IMAGE_LIMIT} images, or its history boundary is unavailable. No current images were discarded. Reduce the current image input or explicitly start a clean handoff.`
    throw new HTTPError(
      message,
      Response.json(
        {
          error: {
            code: "current_turn_image_limit_exceeded",
            message,
          },
        },
        { status: 400 },
      ),
    )
  }

  const omitted = remaining
  const projected = input.map((item, index) => {
    if (
      index >= currentTurnStart
      || remaining === 0
      || imageCounts[index] === 0
    )
      return item
    const content = imageContent(item)!
    const blocks = content.blocks.map((block) => {
      if (block.type !== "input_image" || remaining === 0) return block
      remaining -= 1
      return { type: "input_text", text: OMITTED_HISTORY_IMAGE_TEXT }
    })
    return { ...item, [content.key]: blocks }
  })
  return { payload: { ...payload, input: projected }, omitted }
}
