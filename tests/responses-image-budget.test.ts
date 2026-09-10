import { describe, expect, test } from "bun:test"
import type {
  ResponseInputContent,
  ResponsesPayload,
} from "~/lib/types/responses"
import { HTTPError } from "~/lib/error"
import {
  budgetCopilotResponseImages,
  OMITTED_HISTORY_IMAGE_TEXT,
} from "~/services/copilot/responses-image-budget"

const images = (count: number): ResponseInputContent[] =>
  Array.from({ length: count }, (_, i) => ({
    type: "input_image",
    image_url: `https://example.invalid/image-${i}.png`,
  }))
const countImages = (payload: ResponsesPayload) =>
  JSON.stringify(payload).match(/"type":"input_image"/g)?.length ?? 0
const request = (history: number, current = 1): ResponsesPayload => ({
  model: "gpt-5.6-sol",
  prompt_cache_key: "stable",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "original old text" },
        ...images(history),
      ],
    },
    { role: "assistant", content: "old answer" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "exact new text" },
        ...images(current),
      ],
    },
  ],
})

describe("Copilot Responses history image budget", () => {
  test.each([0, 1, 49, 50])("leaves %i-image requests unchanged", (count) => {
    const input = request(count, 0)
    expect(budgetCopilotResponseImages(input)).toEqual({
      payload: input,
      omitted: 0,
    })
    expect(budgetCopilotResponseImages(input).payload).toBe(input)
  })
  test.each([undefined, "plain text"])(
    "ignores non-array input %s",
    (input) => {
      const payload: ResponsesPayload = { model: "test", input }
      expect(budgetCopilotResponseImages(payload).payload).toBe(payload)
    },
  )
  test("51-image Mori-UX history retains latest screenshot and all original text", () => {
    const original = request(50)
    const saved = structuredClone(original)
    const result = budgetCopilotResponseImages(original)
    expect(result.omitted).toBe(1)
    expect(countImages(result.payload)).toBe(50)
    expect(original).toEqual(saved)
    expect(result.payload.input?.[2]).toEqual(original.input?.[2])
    expect(result.payload.prompt_cache_key).toBe("stable")
    expect(JSON.stringify(result.payload)).toContain("original old text")
    expect(JSON.stringify(result.payload)).toContain(OMITTED_HISTORY_IMAGE_TEXT)
    expect(JSON.stringify(result.payload)).not.toContain(
      'image-0.png"},{"type":"input_image","image_url":"https://example.invalid/image-1.png',
    )
    expect(budgetCopilotResponseImages(result.payload).omitted).toBe(0)
    expect(budgetCopilotResponseImages(original)).toEqual(result)
  })
  test("a text-only follow-up can recover the same 51-image history", () => {
    expect(
      countImages(budgetCopilotResponseImages(request(51, 0)).payload),
    ).toBe(50)
  })
  test.each(["function_call_output", "custom_tool_call_output"])(
    "budgets historical %s images without changing tool pairing",
    (type) => {
      const payload: ResponsesPayload = {
        model: "test",
        input: [
          { type, call_id: "old", output: images(50) },
          { role: "user", content: "new request" },
          { type, call_id: "current", output: images(1) },
        ],
      }
      const saved = structuredClone(payload)
      const result = budgetCopilotResponseImages(payload)
      expect(countImages(result.payload)).toBe(50)
      expect(result.payload.input?.[0]).toMatchObject({ call_id: "old" })
      expect(result.payload.input?.[2]).toEqual(saved.input?.[2])
      expect(payload).toEqual(saved)
    },
  )
  test("counts file IDs and preserves encrypted items and plain outputs", () => {
    const payload = request(49, 1)
    if (!Array.isArray(payload.input)) throw new Error("test input")
    payload.input.unshift(
      { role: "user", content: [{ type: "input_image", file_id: "image-id" }] },
      { type: "reasoning", encrypted_content: "opaque", summary: [] },
      {
        type: "function_call_output",
        call_id: "plain",
        output: "plain output",
      },
    )
    const result = budgetCopilotResponseImages(payload)
    expect(result.omitted).toBe(1)
    expect(result.payload.input?.[1]).toEqual(payload.input[1])
    expect(result.payload.input?.[2]).toEqual(payload.input[2])
  })
  test.each(["new images", "new tool images", "no user boundary"])(
    "fails closed for %s exceeding the budget",
    async (scenario) => {
      const payload =
        scenario === "new images" ?
          request(10, 51)
        : {
            model: "test",
            input: [
              ...(scenario === "new tool images" ?
                [{ role: "user", content: "look" }]
              : []),
              {
                type: "custom_tool_call_output",
                call_id: "current",
                output: images(51),
              },
            ],
          }
      const saved = structuredClone(payload)
      let caught: unknown
      try {
        budgetCopilotResponseImages(payload)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(HTTPError)
      const response = (caught as HTTPError).response
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: "current_turn_image_limit_exceeded" },
      })
      expect(payload).toEqual(saved)
    },
  )
  test("preserves unknown tool output shapes instead of recursively rewriting arbitrary JSON", () => {
    const payload = request(50, 0)
    if (!Array.isArray(payload.input)) throw new Error("test input")
    payload.input.push({
      type: "unknown",
      output: images(100),
      metadata: { type: "input_image" },
    })
    expect(budgetCopilotResponseImages(payload).omitted).toBe(0)
  })
})
