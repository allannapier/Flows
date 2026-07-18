// Agent registry: which coding-agent CLIs Flows knows how to drive, and how
// to turn a FlowStep + rendered prompt into a spawnable command.

import type { AgentDefinition, AgentId, FlowStep } from "../types";

export const AGENTS: AgentDefinition[] = [
  { id: "claude", label: "Claude Code", binary: "claude" },
  { id: "opencode", label: "OpenCode", binary: "opencode" },
  { id: "codex", label: "Codex CLI", binary: "codex" },
  { id: "gemini", label: "Gemini CLI", binary: "gemini" },
  { id: "custom", label: "Custom command" },
];

export function agentAvailable(agent: AgentDefinition): boolean {
  if (agent.id === "custom" || !agent.binary) return true;
  return Bun.which(agent.binary) !== null;
}

/** Agents whose CLI supports a non-interactive "continue last conversation" mode. */
export function agentSupportsContinuation(agent: AgentId): boolean {
  return agent === "claude" || agent === "opencode" || agent === "codex" || agent === "custom";
}

export function buildAgentCommand(
  step: FlowStep,
  prompt: string,
  continueSession: boolean,
): { cmd: string[]; env?: Record<string, string> } {
  const agent: AgentId = step.agent;
  switch (agent) {
    case "claude":
      return {
        cmd: [
          "claude",
          "-p",
          ...(continueSession ? ["--continue"] : []),
          prompt,
          "--output-format",
          "text",
          "--permission-mode",
          "acceptEdits",
        ],
      };
    case "opencode":
      return { cmd: ["opencode", "run", ...(continueSession ? ["--continue"] : []), prompt] };
    case "codex":
      return {
        cmd: continueSession
          ? ["codex", "exec", "resume", "--last", prompt]
          : ["codex", "exec", prompt],
      };
    case "gemini":
      return { cmd: ["gemini", "-p", prompt] };
    case "custom": {
      if (!step.customCommand || step.customCommand.trim() === "") {
        throw new Error(
          `Step "${step.name}" uses the custom agent but has no customCommand configured.`,
        );
      }
      return {
        cmd: ["sh", "-c", step.customCommand],
        env: { FLOW_PROMPT: prompt, FLOW_CONTINUE: continueSession ? "1" : "0" },
      };
    }
    default: {
      const exhaustive: never = agent;
      throw new Error(`Unknown agent id: ${exhaustive as string}`);
    }
  }
}
