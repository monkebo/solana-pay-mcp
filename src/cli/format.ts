// Human rendering when --json is not given. Agents always pass --json; this is for people in a terminal.
export function human(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return `${indent}(none)`;
  if (typeof v !== "object") return `${indent}${String(v)}`;
  if (Array.isArray(v)) {
    if (!v.length) return `${indent}(empty)`;
    return v.map((x, i) => (typeof x === "object" && x !== null ? `${indent}- #${i + 1}\n${human(x, indent + "  ")}` : `${indent}- ${String(x)}`)).join("\n");
  }
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => (typeof x === "object" && x !== null ? `${indent}${k}:\n${human(x, indent + "  ")}` : `${indent}${k}: ${x === null || x === undefined ? "-" : String(x)}`))
    .join("\n");
}
