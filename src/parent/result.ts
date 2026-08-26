export function resultBodyLineCount(content: string): number {
  const separator = content.indexOf("\n\n");
  const body = (separator >= 0 ? content.slice(separator + 2) : "").trimEnd();
  return body ? body.split(/\r?\n/).length : 0;
}

export function collapsedCompletedResult(name: string, id: string, content: string, expansionHint: string): string {
  const count = resultBodyLineCount(content);
  const lines = `${count} ${count === 1 ? "line" : "lines"} returned`;
  return `Subagent ${name} (${id}) completed, ${lines}. ${expansionHint}`;
}
