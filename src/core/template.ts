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

export interface Placeholder {
  kind: "params" | "steps" | "other";
  /** Parameter name (kind "params") or referenced step name (kind "steps").
   *  Absent for "other" (malformed placeholders that don't match either shape). */
  name?: string;
  /** The raw path inside the braces, e.g. "params.foo" or "steps.Bar.output". */
  raw: string;
}

/**
 * Scans `template` for every {{...}} placeholder without rendering or
 * throwing — used by the linter to check placeholders against a flow's
 * declared parameters and step names before a run even starts.
 */
export function listPlaceholders(template: string): Placeholder[] {
  const results: Placeholder[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const path = m[1]!.trim();
    const paramsMatch = /^params\.(.+)$/.exec(path);
    if (paramsMatch) {
      results.push({ kind: "params", name: paramsMatch[1]!.trim(), raw: path });
      continue;
    }
    const stepsMatch = /^steps\.(.+)\.output$/.exec(path);
    if (stepsMatch) {
      results.push({ kind: "steps", name: stepsMatch[1]!.trim(), raw: path });
      continue;
    }
    results.push({ kind: "other", raw: path });
  }
  return results;
}

/**
 * Rewrites every {{steps.<oldName>.output}} placeholder in `template` to
 * reference `newName` instead. Placeholders for other steps/params are left
 * untouched. Used when a step is renamed in the flow editor so other steps'
 * prompts don't dangle.
 */
export function renameStepReferences(template: string, oldName: string, newName: string): string {
  if (oldName === newName) return template;
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  return template.replace(re, (full, rawPath: string) => {
    const path = rawPath.trim();
    const stepsMatch = /^steps\.(.+)\.output$/.exec(path);
    if (stepsMatch && stepsMatch[1]!.trim() === oldName) {
      return `{{steps.${newName}.output}}`;
    }
    return full;
  });
}
