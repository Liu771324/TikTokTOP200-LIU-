const ANSI_PATTERN = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export function summarizeProcessError(stderr, scriptName = "子进程") {
  const clean = String(stderr || "").replace(ANSI_PATTERN, "").replace(/\r/g, "");
  const matches = [...clean.matchAll(/^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|locator\.[^:]+):\s*[^\n]+/gm)];
  let detail = matches.at(-1)?.[0] || "";
  if (!detail) {
    detail = clean.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("at ")).at(-1) || "运行失败";
  }
  detail = detail.replace(/^Error:\s*/i, "").trim();
  const summary = `${scriptName}：${detail}`;
  return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
}
