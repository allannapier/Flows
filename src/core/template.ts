// Prompt template rendering: replaces {{params.<name>}} and
// {{steps.<stepName>.output}} placeholders. Whitespace inside the braces is
// tolerated (e.g. {{ params.foo }}). Unknown placeholders throw.

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function renderTemplate(
  template: string,
  params: Record<string, string>,
  stepOutputs: Record<string, string>,
): string {
  return template.replace(PLACEHOLDER_RE, (full, rawPath: string) => {
    const path = rawPath.trim();
    const paramsMatch = /^params\.(.+)$/.exec(path);
    if (paramsMatch) {
      const name = paramsMatch[1].trim();
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        return params[name];
      }
      throw new Error(`Unknown placeholder: {{${path}}}`);
    }

    const stepsMatch = /^steps\.(.+)\.output$/.exec(path);
    if (stepsMatch) {
      const name = stepsMatch[1].trim();
      if (Object.prototype.hasOwnProperty.call(stepOutputs, name)) {
        return stepOutputs[name];
      }
      throw new Error(`Unknown placeholder: {{${path}}}`);
    }

    throw new Error(`Unknown placeholder: {{${path}}}`);
  });
}
