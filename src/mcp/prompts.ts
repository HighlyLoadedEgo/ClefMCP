import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ClefError, ClefErrorCode } from '../clef/errors.js';

export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  args: Record<string, string>; // arg name -> human description
  build(args: Record<string, string>): string;
}

const TOOL_GUIDE = (questions: string) =>
  [
    'Call the `clef_decide` MCP tool once with all of the questions below (they are scored in a single forward pass).',
    '',
    'Rules for the call:',
    '- `state` must be a compact, factual JSON or string — relevant facts only, well under 1 MB.',
    '- Use the exact `questions` given below (ids, types, criteria). Do not invent extra options.',
    '- If the answer distribution is flat (no option above ~0.6), gather more context and re-ask once before falling back to asking the user.',
    '- Treat safety-adjacent decisions (destructive actions, security) as requiring p >= 0.8 before acting; otherwise prefer asking the user.',
    '- Report the result as a short summary plus the top probability — do not paste raw JSON unless asked.',
    '',
    'Questions:',
    questions,
  ].join('\n');

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'incident-triage',
    title: 'Production incident triage',
    description: 'Frame a production incident as clef_decide questions: immediate action, severity and blast radius.',
    args: {
      incident_description: 'Short factual description of the incident (symptoms, scope, recent changes).',
    },
    build: (a) =>
      TOOL_GUIDE(
        [
          '- "action" (choice, instructions "What should the responder do first?"): rollback "Revert the latest deploy", hotfix "Ship a targeted fix now", investigate "Gather diagnostics before acting", wait "Observe; impact is not growing".',
          '- "severity" (score, instructions "How severe is the incident?", criteria ["low", "elevated", "high", "critical"]).',
          '- "user_impact" (noul, instructions "Are users actively affected right now?").',
        ].join('\n'),
      ) +
      '\n\nIncident description:\n' +
      (a.incident_description ?? ''),
  },
  {
    name: 'next-action',
    title: 'Agent next action',
    description: 'Ask Clef what the coding agent should do next on a task: inspect, modify, test or ask the user.',
    args: {
      task_summary: 'What the agent is working on, current step, and what is already known or done.',
    },
    build: (a) =>
      TOOL_GUIDE(
        [
          '- "next_action" (choice, instructions "What should the coding agent do next?"): inspect "Inspect the code and gather more information", modify "Modify the code", test "Run additional tests", ask_user "Ask the user for clarification".',
          '- "confidence" (score, instructions "How confident are you in this decision?", criteria ["very_low", "low", "medium", "high", "very_high"]).',
        ].join('\n'),
      ) +
      '\n\nTask summary:\n' +
      (a.task_summary ?? ''),
  },
  {
    name: 'ticket-routing',
    title: 'Support ticket routing',
    description: 'Classify an incoming message into the team that should handle it.',
    args: {
      ticket_text: 'The customer or user message, verbatim if possible.',
    },
    build: (a) =>
      TOOL_GUIDE(
        [
          '- "department" (choice, instructions "Which team should handle the message?"): billing "Payments, invoices and refunds", technical "Bugs, errors and outages", sales "Pricing and new purchases", other "Anything else".',
          '- "urgent" (noul, instructions "Does this need a response within the hour?").',
        ].join('\n'),
      ) +
      '\n\nTicket text:\n' +
      (a.ticket_text ?? ''),
  },
  {
    name: 'security-review',
    title: 'Security sanity check',
    description: 'Ask Clef whether a code snippet, change or setup smells like a security problem.',
    args: {
      change_summary: 'The code, config or setup to review — compact but complete enough to judge.',
    },
    build: (a) =>
      TOOL_GUIDE(
        [
          '- "is_vulnerable" (noul, instructions "Does this contain a realistic security vulnerability?").',
          '- "risk" (score, instructions "How bad is it if this ships as-is?", criteria ["informational", "low", "medium", "high", "critical"]).',
          '- "first_mitigation" (choice, instructions "What is the first mitigation?"): fix_code "Fix the code before merging", restrict "Restrict access or add guardrails", monitor "Add detection and monitoring", none "No mitigation needed".',
        ].join('\n') +
        '\nSafety rule: only act without human review when p(is_vulnerable=false) >= 0.8.',
      ) +
      '\n\nChange to review:\n' +
      (a.change_summary ?? ''),
  },
];

/** Register all bundled prompts on the server. */
export function registerPrompts(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      {
        title: p.title,
        description: p.description,
        argsSchema: Object.fromEntries(Object.entries(p.args).map(([k, v]) => [k, z.string().min(1).describe(v)])),
      },
      ({ ...args }) => {
        for (const key of Object.keys(p.args)) {
          if (typeof args[key] !== 'string' || !args[key]) {
            throw new ClefError(ClefErrorCode.INVALID_INPUT, `Prompt argument "${key}" is required`);
          }
        }
        return {
          messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.build(args as Record<string, string>) } }],
        };
      },
    );
  }
}
