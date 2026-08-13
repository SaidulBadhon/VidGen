/**
 * Merges filter decisions and turns them into the block list the pipeline narrates.
 *
 * The structural pass is only ever a proposal. This module is where a reviewer's
 * corrections become authoritative and where the "we dropped 412 blocks, here is why"
 * summary comes from. Nothing here drops a block on its own: a block is only removed
 * when some decision explicitly says so.
 */

import type { Block, BookStructure, FilterDecision } from "../types.ts";

/**
 * Combines the automatic pass with later refinements.
 *
 * A `user` decision always wins, whatever its confidence and whatever order the
 * arrays arrive in. That is the entire point of the review UI: an override the user
 * made by hand must never be recomputed away by a re-run of the structural pass or by
 * a later LLM pass. Non-user overrides refine structural decisions but stop at a
 * user's. Structural order is preserved so the UI list does not reshuffle on merge.
 */
export function mergeDecisions(structural: FilterDecision[], overrides: FilterDecision[]): FilterDecision[] {
  const merged = new Map<string, FilterDecision>();
  const order: string[] = [];

  for (const decision of structural) {
    if (!merged.has(decision.blockId)) order.push(decision.blockId);
    merged.set(decision.blockId, decision);
  }

  for (const override of overrides) {
    const existing = merged.get(override.blockId);
    if (!existing) {
      order.push(override.blockId);
      merged.set(override.blockId, override);
      continue;
    }
    if (existing.source === "user" && override.source !== "user") continue;
    merged.set(override.blockId, override);
  }

  return order.map((blockId) => merged.get(blockId)!);
}

/**
 * The blocks that survive filtering, in reading order.
 *
 * A block with no decision at all is kept. Absence of a verdict is not a verdict, and
 * treating a gap in the decision list as a drop would be exactly the silent deletion
 * this pipeline is built to avoid.
 */
export function keptBlocks(structure: BookStructure, decisions: FilterDecision[]): Block[] {
  const byBlockId = new Map<string, FilterDecision>(decisions.map((decision) => [decision.blockId, decision]));
  return [...structure.blocks]
    .sort((a, b) => a.order - b.order)
    .filter((block) => byBlockId.get(block.id)?.keep !== false);
}

export interface RuleSummary {
  rule: string;
  kept: number;
  dropped: number;
  /** Reason text of the first decision carrying this rule, used as the UI row label. */
  reason: string;
}

export interface DecisionSummary {
  total: number;
  kept: number;
  dropped: number;
  /** One row per rule, most-dropped first so the UI leads with the biggest cuts. */
  rules: RuleSummary[];
}

/** Counts per rule, for the review UI's headline summary of what was removed. */
export function decisionSummary(decisions: FilterDecision[]): DecisionSummary {
  const rules = new Map<string, RuleSummary>();
  let kept = 0;

  for (const decision of decisions) {
    if (decision.keep) kept += 1;
    const existing = rules.get(decision.rule);
    if (existing) {
      if (decision.keep) existing.kept += 1;
      else existing.dropped += 1;
      continue;
    }
    rules.set(decision.rule, {
      rule: decision.rule,
      kept: decision.keep ? 1 : 0,
      dropped: decision.keep ? 0 : 1,
      reason: decision.reason,
    });
  }

  return {
    total: decisions.length,
    kept,
    dropped: decisions.length - kept,
    rules: [...rules.values()].sort(
      (a, b) => b.dropped - a.dropped || b.kept - a.kept || a.rule.localeCompare(b.rule),
    ),
  };
}
