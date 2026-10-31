const answerHeading = /^(?:Answer text|Rendered answer|平台回答转录)$/iu;

/** Only registered answer sections/fields are displayable; reports are not answers. */
export function extractAnswerContent(
  raw: string,
  options: { standalone?: boolean } = {},
): string | null {
  // The caller must establish standalone provenance from saved provider records.
  if (options.standalone) return raw.trim() || null;

  if (/^\s*[\[{]/.test(raw)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      for (const key of ['answer_text', 'answerText', 'rendered_answer', 'renderedAnswer']) {
        if (typeof record[key] === 'string' && record[key].trim()) {
          return stripTrailingCaptureNote(record[key]);
        }
      }
    } catch { /* An unrecognized or malformed report has no displayable answer. */ }
    return null;
  }

  const lines = raw.split('\n');
  let fence: string | null = null;
  let depth: number | null = null;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = boundary;
      else if (boundary[0] === fence[0] && boundary.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    if (depth !== null && heading[1].length <= depth) {
      return stripTrailingCaptureNote(lines.slice(start, index).join('\n'));
    }
    if (depth === null && answerHeading.test(heading[2])) {
      depth = heading[1].length;
      start = index + 1;
    }
  }
  return start < 0 ? null : stripTrailingCaptureNote(lines.slice(start).join('\n'));
}

function stripTrailingCaptureNote(value: string): string | null {
  // Capture annotations are outside the answer. Keep the answer's own citations,
  // tables, source headings, and code blocks intact.
  const lines = value.split('\n');
  let fence: string | null = null;
  let captureIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const boundary = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = boundary;
      else if (boundary[0] === fence[0] && boundary.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
    }
    if (!fence && /^Capture(?: note)?:/i.test(line)) captureIndex = index;
    else if (line.trim()) captureIndex = -1;
  }
  return (captureIndex < 0 ? value : lines.slice(0, captureIndex).join('\n')).trim() || null;
}
