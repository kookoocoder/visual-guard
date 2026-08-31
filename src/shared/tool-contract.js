export const TOOL_DEFINITIONS = [
  {
    name: "get_page_state",
    label: "Read page",
    description: "Return the redacted accessibility summary for the active tab.",
    payload: {},
    category: "observe",
  },
  {
    name: "read_element",
    label: "Read element",
    description: "Read one element by its stable ref. Sensitive values stay redacted.",
    payload: { selector_ref: "ref_1" },
    category: "observe",
  },
  {
    name: "click",
    label: "Click",
    description: "Click an element by its stable ref.",
    payload: { selector_ref: "ref_1" },
    category: "act",
  },
  {
    name: "type",
    label: "Type",
    description: "Type into a non-sensitive element by its stable ref.",
    payload: { selector_ref: "ref_1", text: "Local test" },
    category: "act",
  },
  {
    name: "scroll",
    label: "Scroll",
    description: "Scroll the active tab by a fixed number of pixels.",
    payload: { direction: "down", amount_px: 320 },
    category: "act",
  },
  {
    name: "navigate",
    label: "Navigate",
    description: "Navigate to an explicit http(s) URL.",
    payload: { url: "https://example.com" },
    category: "act",
  },
  {
    name: "screenshot",
    label: "Screenshot",
    description: "Capture the viewport; only the locally redacted frame is returned.",
    payload: {},
    category: "observe",
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(({ name }) => name));

export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
