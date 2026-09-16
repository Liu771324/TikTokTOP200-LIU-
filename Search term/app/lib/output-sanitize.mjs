const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const XML_INVALID_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function sanitizeCellValue(value) {
  if (typeof value !== "string") return value;
  return value.replace(ANSI_PATTERN, "").replace(XML_INVALID_PATTERN, "");
}
