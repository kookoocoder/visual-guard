import { TOOL_DEFINITIONS } from "../shared/tool-contract.js";

const PARAMETER_SCHEMAS = {
  list_tabs: {
    type: "object",
    properties: {},
    required: [],
  },
  list_bookmarks: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Words matched against bookmark title, folder, and URL, such as GATE CS. Omit only when the user wants the full saved-links list.",
      },
    },
    required: [],
  },
  get_page_state: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief why you need page state." },
      tab_id: { type: "integer", description: "Optional tab ID returned by list_tabs. Defaults to the active tab." },
    },
    required: [],
  },
  read_element: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable element ref, e.g. ref_1." },
      tab_id: { type: "integer", description: "Optional target tab ID. Use the same tab that supplied selector_ref." },
    },
    required: ["selector_ref"],
  },
  click: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable element ref to click." },
      tab_id: { type: "integer", description: "Optional target tab ID. Use the same tab that supplied selector_ref." },
    },
    required: ["selector_ref"],
  },
  type: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable element ref to type into." },
      text: { type: "string", description: "Text to type. Never include secrets the user did not provide." },
      tab_id: { type: "integer", description: "Optional target tab ID. Use the same tab that supplied selector_ref." },
    },
    required: ["selector_ref", "text"],
  },
  upload_image: {
    type: "object",
    properties: {
      selector_ref: {
        type: "string",
        description:
          "Stable ref of a role \"file\" input, or of the attach control that owns one. Omit to use the page's image file input.",
      },
      tab_id: { type: "integer", description: "Optional target tab ID. Use the chat tab, not the tab you screenshotted." },
    },
    required: [],
  },
  press_key: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable ref of the element that should receive the key." },
      key: { type: "string", enum: ["Enter", "Escape", "Tab"], description: "Keyboard key to press." },
      tab_id: { type: "integer", description: "Optional target tab ID. Use the same tab that supplied selector_ref." },
    },
    required: ["selector_ref", "key"],
  },
  submit: {
    type: "object",
    properties: {
      selector_ref: { type: "string", description: "Stable ref of the populated form or chat composer." },
      tab_id: { type: "integer", description: "Optional target tab ID. Use the same tab that supplied selector_ref." },
    },
    required: ["selector_ref"],
  },
  scroll: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
      amount_px: { type: "integer", description: "Pixels to scroll.", minimum: 1 },
      tab_id: { type: "integer", description: "Optional target tab ID." },
    },
    required: ["direction"],
  },
  navigate: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      tab_id: { type: "integer", description: "Optional target tab ID. Defaults to the active tab." },
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
