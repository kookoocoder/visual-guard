import { TOOL_DEFINITIONS } from "../shared/tool-contract.js";

const PARAMETER_SCHEMAS = {
  get_page_state: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief why you need page state." },
    },
    required: [],
  },
  read_element: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable element ref, e.g. ref_1." },
    },
    required: ["selector_ref"],
  },
  click: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable element ref to click." },
    },
    required: ["selector_ref"],
  },
  type: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable element ref to type into." },
      text: { type: "string", description: "Text to type. Never include secrets the user did not provide." },
    },
    required: ["selector_ref", "text"],
  },
  scroll: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
      amount_px: { type: "integer", description: "Pixels to scroll.", minimum: 1 },
    },
    required: ["direction"],
  },
  navigate: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
    },
    required: ["url"],
  },
  screenshot: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief why you need a redacted viewport capture." },
    },
    required: [],
  },
};

/** OpenAI Chat Completions `tools` array derived from the shared tool contract. */
export function buildOpenAiTools() {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: PARAMETER_SCHEMAS[tool.name] ?? {
        type: "object",
        properties: {},
        required: [],
      },
    },
  }));
}

export function parseToolCallArguments(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
