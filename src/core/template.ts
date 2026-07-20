// Prompt template rendering: replaces {{params.<name>}} and
// {{steps.<stepName>.output}} placeholders. Whitespace inside the braces is
// tolerated (e.g. {{ params.foo }}). Unknown placeholders throw.

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function render(
  template: string,
  params: Record<string, string>,
  stepOutputs: Record<string, string>,
  allowSteps: boolean,
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
      if (!allowSteps) {
        throw new Error(`{{${path}}} is not allowed here — step outputs cannot be used in a working directory`);
      }
      const name = stepsMatch[1].trim();
      if (Object.prototype.hasOwnProperty.call(stepOutputs, name)) {
        return stepOutputs[name];
      }
      throw new Error(`Unknown placeholder: {{${path}}}`);
    }

    throw new Error(`Unknown placeholder: {{${path}}}`);
  });
}

export function renderTemplate(
  template: string,
  params: Record<string, string>,
  stepOutputs: Record<string, string>,
): string {
  return render(template, params, stepOutputs, true);
}

/**
 * Resolves only {{params.<name>}} placeholders in `template`; a
 * {{steps.<name>.output}} placeholder is rejected with a clear error rather
 * than silently rendering — used for working directories, which must be
 * resolvable before any step runs and must never depend on multi-line agent
 * output.
 */
export function renderParamsOnly(template: string, params: Record<string, string>): string {
  return render(template, params, {}, false);
}
