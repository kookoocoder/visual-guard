export const TOOL_DEFINITIONS = [
  {
    name: "list_tabs",
    label: "List tabs",
    description: "List the browser tabs available to the agent, including their tab IDs.",
    payload: {},
    category: "observe",
  },
  {
    name: "list_bookmarks",
    label: "List bookmarks",
    description: "Search the user's saved Chrome bookmarks by title, folder, or URL. Use this instead of opening chrome://bookmarks.",
    payload: { query: "GATE CS" },
    category: "observe",
  },
  {
    name: "get_page_state",
    label: "Read page",
    description: "Return the redacted accessibility summary for the active tab or a tab ID from list_tabs.",
    payload: { tab_id: 123 },
    category: "observe",
  },
  {
    name: "read_element",
    label: "Read element",
    description: "Read one element by its stable ref. Sensitive values stay redacted.",
    payload: { selector_ref: "ref_1", tab_id: 123 },
    category: "observe",
  },
  {
    name: "click",
    label: "Click",
    description: "Click an element by its stable ref.",
    payload: { selector_ref: "ref_1", tab_id: 123 },
    category: "act",
  },
  {
    name: "type",
    label: "Type",
    description: "Type into a non-sensitive element by its stable ref.",
    payload: { selector_ref: "ref_1", text: "Local test", tab_id: 123 },
    category: "act",
  },
  {
    name: "upload_image",
    label: "Upload image",
    description: "Attach the last on-device screenshot to a file input. Pass a file-input ref when one is listed; otherwise the page's image file input is used.",
    payload: { selector_ref: "ref_1", tab_id: 123 },
    category: "act",
  },
  {
    name: "press_key",
    label: "Press key",
    description: "Press a keyboard key on a focused element, such as Enter to submit a message.",
    payload: { selector_ref: "ref_1", key: "Enter", tab_id: 123 },
    category: "act",
  },
  {
    name: "submit",
    label: "Submit",
    description: "Submit the current form or chat composer using its live Send/Submit control.",
    payload: { selector_ref: "ref_1", tab_id: 123 },
    category: "act",
  },
  {
    name: "scroll",
    label: "Scroll",
    description: "Scroll the active tab by a fixed number of pixels.",
    payload: { direction: "down", amount_px: 320, tab_id: 123 },
    category: "act",
  },
  {
    name: "navigate",
    label: "Navigate",
    description: "Navigate to an explicit http(s) URL.",
    payload: { url: "https://example.com", tab_id: 123 },
    category: "act",
  },
  {
    name: "screenshot",
    label: "Screenshot",
    description: "Capture the viewport and store it on-device for upload_image. The chat model receives a summary, not pixels.",
    payload: {},
    category: "observe",
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(({ name }) => name));

export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
