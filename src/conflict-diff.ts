// Bound both the diff calculation and comment size for large descriptions.
const MAX_LINES = 200;
const MAX_DIFF_LINES = 32;
const MAX_SECTION_CHARS = 1800;
const MAX_TOTAL_CHARS = 8000;

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : JSON.stringify(value, null, 2);
}

function fenced(body: string, language = ""): string {
  const runs = body.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}${language}\n${body}\n${fence}`;
}

function lineDiff(left: string, right: string): string {
  let a = left.split("\n");
  let b = right.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  // Keep one line of shared context at each end, even for edits near the end of a long document.
  a = a.slice(Math.max(0, prefix - 1), suffix ? a.length - suffix + 1 : undefined);
  b = b.slice(Math.max(0, prefix - 1), suffix ? b.length - suffix + 1 : undefined);
  const inputTruncated = a.length > MAX_LINES || b.length > MAX_LINES;
  a = a.slice(0, MAX_LINES);
  b = b.slice(0, MAX_LINES);
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      const start = i;
      while (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
      lines.push(` ${a[start]}`);
      if (i - start > 2) lines.push(" ...");
      if (i - start > 1) lines.push(` ${a[i - 1]}`);
    } else if (i < a.length && (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])) {
      lines.push(`-${a[i++]}`);
    } else {
      lines.push(`+${b[j++]}`);
    }
  }
  const output = lines.slice(0, MAX_DIFF_LINES).join("\n");
  const truncated = inputTruncated || lines.length > MAX_DIFF_LINES || output.length > MAX_SECTION_CHARS;
  return output.slice(0, MAX_SECTION_CHARS) + (truncated ? "\n... (diff truncated; open both records for full values)" : "");
}

export function formatConflictDiff(
  fields: readonly string[],
  personal: object,
  external: object,
  personalName: string,
  externalName: string,
): string {
  const sections: string[] = [];
  const left = personal as Record<string, unknown>;
  const right = external as Record<string, unknown>;
  for (const field of fields) {
    if (!(field in left) || !(field in right)) continue;
    const a = display(left[field]);
    const b = display(right[field]);
    const textField = ["content", "description", "name", "title", "resources"].includes(field);
    const body = textField
      ? `--- ${personalName}\n+++ ${externalName}\n${lineDiff(a, b)}`
      : `${personalName}: ${a.slice(0, 500)}\n${externalName}: ${b.slice(0, 500)}`;
    const section = `**${field}**\n\n${fenced(body, textField ? "diff" : "")}`;
    if (sections.join("\n\n").length + section.length > MAX_TOTAL_CHARS) {
      sections.push("Additional differences omitted; open both records for full values.");
      break;
    }
    sections.push(section);
  }
  return sections.join("\n\n");
}
