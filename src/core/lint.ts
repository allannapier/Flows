// Flow integrity linting: catches broken placeholder references and
// out-of-range routing before they blow up mid-run (or silently produce an
// empty step output). Run at save time by the flow editor and again just
// before a run starts, since a flow can reach storage without going through
// the editor's own safeguards (hand-edited JSON, import).

import type { Flow } from "../types";
import { listPlaceholders } from "./template";

export interface FlowLintIssue {
  severity: "error" | "warning";
  stepIndex?: number;
  message: string;
}

function stepLabel(name: string, index: number): string {
  return name.trim() !== "" ? `"${name}"` : `#${index + 1}`;
}

export function lintFlow(flow: Flow): FlowLintIssue[] {
  const issues: FlowLintIssue[] = [];
  const paramNames = new Set(flow.parameters.map((p) => p.name));

  // First-occurrence index of each step name, used to resolve
  // {{steps.<name>.output}} references and to detect forward references.
  const firstIndexOfName = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  flow.steps.forEach((step, i) => {
    nameCounts.set(step.name, (nameCounts.get(step.name) ?? 0) + 1);
    if (!firstIndexOfName.has(step.name)) firstIndexOfName.set(step.name, i);
  });
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      issues.push({
        severity: "warning",
        message: `${count} steps are named "${name}" — {{steps.${name}.output}} references are ambiguous (first match wins)`,
      });
    }
  }

  function checkPlaceholders(text: string, stepIndex: number, label: string, allowSteps: boolean) {
    for (const ph of listPlaceholders(text)) {
      if (ph.kind === "params") {
        if (!paramNames.has(ph.name!)) {
          issues.push({
            severity: "error",
            stepIndex,
            message: `Step ${stepLabel(flow.steps[stepIndex]!.name, stepIndex)} ${label} references unknown parameter {{params.${ph.name}}}`,
          });
        }
      } else if (ph.kind === "steps") {
        if (!allowSteps) {
          issues.push({
            severity: "error",
            stepIndex,
            message: `Step ${stepLabel(flow.steps[stepIndex]!.name, stepIndex)} ${label} references {{steps.${ph.name}.output}}, which is not allowed in a working directory`,
          });
          continue;
        }
        const targetIdx = firstIndexOfName.get(ph.name!);
        if (targetIdx === undefined) {
          issues.push({
            severity: "error",
            stepIndex,
            message: `Step ${stepLabel(flow.steps[stepIndex]!.name, stepIndex)} ${label} references unknown step {{steps.${ph.name}.output}}`,
          });
        } else if (targetIdx >= stepIndex) {
          issues.push({
            severity: "warning",
            stepIndex,
            message: `Step ${stepLabel(flow.steps[stepIndex]!.name, stepIndex)} ${label} references {{steps.${ph.name}.output}}, which runs at or after this step — its output will be empty/unknown`,
          });
        }
      }
    }
  }

  flow.steps.forEach((step, i) => {
    checkPlaceholders(step.prompt, i, "prompt", true);
    checkPlaceholders(step.expectedResult, i, "expected result", true);
    if (step.workingDir) checkPlaceholders(step.workingDir, i, "working directory", false);

    if (step.routing) {
      const { onSuccess, onFailure } = step.routing;
      if (onSuccess !== undefined && (onSuccess < 0 || onSuccess >= flow.steps.length)) {
        issues.push({
          severity: "error",
          stepIndex: i,
          message: `Step ${stepLabel(step.name, i)} on-success routing targets step ${onSuccess + 1}, which is out of range (flow has ${flow.steps.length} step${flow.steps.length === 1 ? "" : "s"})`,
        });
      }
      if (onFailure !== undefined && (onFailure < 0 || onFailure >= flow.steps.length)) {
        issues.push({
          severity: "error",
          stepIndex: i,
          message: `Step ${stepLabel(step.name, i)} on-failure routing targets step ${onFailure + 1}, which is out of range (flow has ${flow.steps.length} step${flow.steps.length === 1 ? "" : "s"})`,
        });
      }
    }

    if (step.agent === "custom" && !step.customCommand?.trim()) {
      issues.push({
        severity: "error",
        stepIndex: i,
        message: `Step ${stepLabel(step.name, i)} uses the custom agent but has no command configured`,
      });
    }
  });

  if (flow.workingDir) {
    for (const ph of listPlaceholders(flow.workingDir)) {
      if (ph.kind === "params" && !paramNames.has(ph.name!)) {
        issues.push({ severity: "error", message: `Flow working directory references unknown parameter {{params.${ph.name}}}` });
      } else if (ph.kind === "steps") {
        issues.push({
          severity: "error",
          message: `Flow working directory references {{steps.${ph.name}.output}}, which is not allowed in a working directory`,
        });
      }
    }
  }

  for (const p of flow.parameters) {
    if (p.choices?.length && p.default !== undefined && p.default !== "" && !p.choices.includes(p.default)) {
      issues.push({ severity: "warning", message: `Parameter "${p.name}" has a default ("${p.default}") that isn't one of its choices` });
    }
  }

  return issues;
}
