// Static catalog of safeguard rules. The daemon's rules engine (packages/daemon/src/rules.ts)
// and the Flags panel both import this so rule ids, default severities and explanations
// stay in one place. Order = evaluation priority within a severity tier.
import type { HenryConfig, Severity } from "./types";

/** Keys of HenryConfig.rules whose value is a Severity that overrides a rule's default. */
export type RuleSeverityKey = "crossRepoWrite" | "commitOnProtected" | "pushToProtected";

export interface RuleInfo {
  /** Stable kebab-case id stored on flags and events. */
  id: string;
  /** Default severity; `configKey` (if any) names the config field that overrides it ("info" = off). */
  severity: Severity;
  description: string;
  configKey?: RuleSeverityKey;
}

export const RULE_CATALOG: readonly RuleInfo[] = [
  {
    id: "secret-path",
    severity: "alarm",
    description: "A tool read or wrote a secret-looking path (.env, *.pem, *.key, id_rsa, .netrc, secrets/, credentials/). Claude's own settings should deny these, so one getting through matters.",
  },
  {
    id: "force-push",
    severity: "alarm",
    description: "git push with --force, -f, --force-with-lease, or a +refspec.",
  },
  {
    id: "history-rewrite",
    severity: "alarm",
    description: "A repo's HEAD moved backwards: a reset, rebase, or amend rewrote history that was already there.",
  },
  {
    id: "command-alarm",
    severity: "alarm",
    description: "A Bash command matched a pattern in rules.alarm (case-insensitive substring, or /regex/).",
  },
  {
    id: "commit-on-protected",
    severity: "alarm",
    configKey: "commitOnProtected",
    description: "git commit ran while the repo was checked out on a protected branch (rules.protectedBranches).",
  },
  {
    id: "push-to-protected",
    severity: "notable",
    configKey: "pushToProtected",
    description: "git push targeted a protected branch: an explicit ref like `origin main`, or no ref while the current branch is protected.",
  },
  {
    id: "cross-repo-write",
    severity: "notable",
    configKey: "crossRepoWrite",
    description: "A write (edit tool, redirect, rm/mv/cp/sed -i, or git) landed in a different repo than the one the session started in.",
  },
  {
    id: "outside-repos-write",
    severity: "notable",
    description: "A write landed outside reposRoot entirely (for example ~/.claude or /etc). Temp dirs and /dev are ignored.",
  },
  {
    id: "branch-churn",
    severity: "notable",
    description: "Branch or worktree churn: checkout -b, switch -c, worktree add/remove, branch -D/-d, stash.",
  },
  {
    id: "command-notable",
    severity: "notable",
    description: "A Bash command matched a pattern in rules.notable (case-insensitive substring, or /regex/).",
  },
  {
    id: "subagent-storm",
    severity: "notable",
    description: "More than rules.maxSubagentsPer10m subagents finished within ten minutes in one session (flagged once per window).",
  },
];

const byId = new Map(RULE_CATALOG.map((r) => [r.id, r]));

/** One-line human explanation for a rule id; unknown ids get a generic line rather than throwing. */
export function explainRule(id: string): string {
  return byId.get(id)?.description ?? `Unknown rule "${id}" (it may come from a newer daemon).`;
}

/** The catalog with severities resolved against a config's rules section. */
export function rulesWithConfig(rules: Partial<HenryConfig["rules"]> | null | undefined): RuleInfo[] {
  return RULE_CATALOG.map((r) => {
    if (!r.configKey || !rules) return { ...r };
    const v = rules[r.configKey];
    return { ...r, severity: v === "alarm" || v === "notable" || v === "info" ? v : r.severity };
  });
}
