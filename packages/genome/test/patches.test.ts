import { describe, it, expect } from "vitest";
import { MutationPolicyError, GenomeValidationError } from "@meta/shared";
import {
  applyPatches,
  diffGenomes,
  hashGenome,
  isEmptyDiff,
  loadTemplate,
  parseGenome,
  BALANCED_ANALYSIS,
  type MutationPatchInput,
} from "../src/index.js";

const permissive = () => {
  const g = structuredClone(BALANCED_ANALYSIS);
  g.mutationPolicy = {
    humanApprovalRequired: false,
    allowed: [
      "ADD_AGENT",
      "REMOVE_AGENT",
      "UPDATE_PROMPT",
      "UPDATE_MODEL",
      "ADD_EDGE",
      "REMOVE_EDGE",
      "CHANGE_PROTOCOL",
      "CHANGE_MEMORY_POLICY",
      "CHANGE_STOP_CRITERIA",
    ],
    maxMutationsPerRun: 5,
  };
  return parseGenome(g);
};

const newAgent = (id: string): MutationPatchInput => ({
  type: "ADD_AGENT",
  agent: {
    id,
    name: `Agent ${id}`,
    role: "additional perspective",
    cognitiveMode: "creative",
    systemPrompt: "Offer an angle the others have not considered.",
    model: { primary: "anthropic/claude-sonnet-4" },
  },
});

describe("purity", () => {
  it("never mutates the input genome", () => {
    const before = permissive();
    const snapshot = hashGenome(before);

    applyPatches(before, [newAgent("outsider")], { actor: "HUMAN" });

    expect(hashGenome(before)).toBe(snapshot);
    expect(before.agents.some((a) => a.id === "outsider")).toBe(false);
  });

  it("produces a genome with a different hash", () => {
    const before = permissive();
    const { genome: after } = applyPatches(before, [newAgent("outsider")], { actor: "HUMAN" });
    expect(hashGenome(after)).not.toBe(hashGenome(before));
    expect(after.agents).toHaveLength(before.agents.length + 1);
  });

  it("is deterministic: the same patches yield the same hash", () => {
    const a = applyPatches(permissive(), [newAgent("x")], { actor: "HUMAN" });
    const b = applyPatches(permissive(), [newAgent("x")], { actor: "HUMAN" });
    expect(hashGenome(a.genome)).toBe(hashGenome(b.genome));
  });
});

describe("patch semantics", () => {
  it("updates a prompt without touching anything else", () => {
    const before = permissive();
    const { genome: after } = applyPatches(
      before,
      [{ type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "Be relentless but fair." }],
      { actor: "HUMAN" },
    );
    const diff = diffGenomes(before, after);
    expect(diff.agentsChanged).toEqual([{ id: "skeptic", fields: ["systemPrompt"] }]);
    expect(diff.agentsAdded).toEqual([]);
    expect(diff.edgesAdded).toEqual([]);
  });

  it("merges a partial model update instead of replacing the config", () => {
    const before = permissive();
    const originalPrimary = before.agents.find((a) => a.id === "skeptic")!.model.primary;

    const { genome: after } = applyPatches(
      before,
      [{ type: "UPDATE_MODEL", agentId: "skeptic", model: { temperature: 0.2 } }],
      { actor: "HUMAN" },
    );

    const updated = after.agents.find((a) => a.id === "skeptic")!;
    expect(updated.model.temperature).toBe(0.2);
    // The bug this guards: spreading a Zod partial would blank `primary`.
    expect(updated.model.primary).toBe(originalPrimary);
  });

  it("removes edges that would dangle when an agent is removed", () => {
    const before = permissive();
    expect(before.edges.some((e) => e.from === "systems-thinker" || e.to === "systems-thinker"))
      .toBe(true);

    const { genome: after } = applyPatches(
      before,
      [{ type: "REMOVE_AGENT", agentId: "systems-thinker" }],
      { actor: "HUMAN" },
    );

    expect(after.agents.some((a) => a.id === "systems-thinker")).toBe(false);
    expect(
      after.edges.some((e) => e.from === "systems-thinker" || e.to === "systems-thinker"),
    ).toBe(false);
  });

  it("refuses to remove the synthesizer", () => {
    const before = permissive();
    expect(() =>
      applyPatches(before, [{ type: "REMOVE_AGENT", agentId: "synthesizer" }], {
        actor: "HUMAN",
      }),
    ).toThrow(/it is the synthesizer/);
  });

  it("refuses to add an agent that already exists", () => {
    expect(() => applyPatches(permissive(), [newAgent("skeptic")], { actor: "HUMAN" })).toThrow(
      MutationPolicyError,
    );
  });

  it("treats ADD_EDGE as idempotent", () => {
    const before = permissive();
    const patch: MutationPatchInput = {
      type: "ADD_EDGE",
      edge: { from: "skeptic", to: "empiricist", interaction: "challenge", weight: 1 },
    };
    const { genome: after } = applyPatches(before, [patch, patch], { actor: "HUMAN" });
    expect(after.edges.filter((e) => e.from === "skeptic" && e.to === "empiricist")).toHaveLength(
      1,
    );
  });

  it("validates the result, rejecting a patch set that breaks the organization", () => {
    const before = permissive();
    // Removing every challenge edge leaves crossChallenge enabled with nothing
    // to drive the stage — invalid, and caught before it can ever run.
    const removals = before.edges
      .filter((e) => e.interaction === "challenge")
      .map((e): MutationPatchInput => ({
        type: "REMOVE_EDGE",
        from: e.from,
        to: e.to,
        interaction: e.interaction,
      }));

    expect(() => applyPatches(before, removals, { actor: "HUMAN" })).toThrow(
      GenomeValidationError,
    );
  });

  it("applies patches in order", () => {
    const before = permissive();
    const { genome: after } = applyPatches(
      before,
      [
        { type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "first" },
        { type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "second" },
      ],
      { actor: "HUMAN" },
    );
    expect(after.agents.find((a) => a.id === "skeptic")!.systemPrompt).toBe("second");
  });
});

describe("mutation policy enforcement", () => {
  it("rejects a mutation type not in the allowed list", () => {
    const genome = permissive(); // UPDATE_CAPABILITIES is not allowed
    expect(() =>
      applyPatches(
        genome,
        [{ type: "UPDATE_CAPABILITIES", agentId: "skeptic", capabilities: ["code_execution"] }],
        { actor: "HUMAN" },
      ),
    ).toThrow(/not in mutationPolicy.allowed/);
  });

  it("rejects watcher patches when the genome requires human approval", () => {
    const genome = parseGenome(BALANCED_ANALYSIS); // humanApprovalRequired defaults true
    expect(() =>
      applyPatches(
        genome,
        [{ type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "revised" }],
        { actor: "WATCHER" },
      ),
    ).toThrow(/requires? approval|need approval/i);
  });

  it("accepts the same watcher patch once a human has approved it", () => {
    const genome = parseGenome(BALANCED_ANALYSIS);
    const { genome: after } = applyPatches(
      genome,
      [{ type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "revised" }],
      { actor: "WATCHER", humanApproved: true },
    );
    expect(after.agents.find((a) => a.id === "skeptic")!.systemPrompt).toBe("revised");
  });

  it("caps how many patches a watcher may propose in one run", () => {
    const g = structuredClone(BALANCED_ANALYSIS);
    g.mutationPolicy = {
      humanApprovalRequired: false,
      allowed: ["UPDATE_PROMPT"],
      maxMutationsPerRun: 1,
    };
    const genome = parseGenome(g);

    expect(() =>
      applyPatches(
        genome,
        [
          { type: "UPDATE_PROMPT", agentId: "skeptic", systemPrompt: "a" },
          { type: "UPDATE_PROMPT", agentId: "empiricist", systemPrompt: "b" },
        ],
        { actor: "WATCHER" },
      ),
    ).toThrow(/maxMutationsPerRun/);
  });

  it("rejects all mutation when the policy is disabled", () => {
    const g = structuredClone(BALANCED_ANALYSIS);
    g.mutationPolicy = { enabled: false };
    expect(() =>
      applyPatches(parseGenome(g), [newAgent("x")], { actor: "HUMAN" }),
    ).toThrow(/mutation is disabled/);
  });

  it("lets breeding bypass policy, since it composes already-valid parents", () => {
    const genome = parseGenome(BALANCED_ANALYSIS);
    const { genome: after } = applyPatches(genome, [newAgent("bred-in")], {
      actor: "BREEDING",
      bypassPolicy: true,
    });
    expect(after.agents.some((a) => a.id === "bred-in")).toBe(true);
  });
});

describe("watcher privilege escalation", () => {
  const escalating = (): MutationPatchInput[] => [
    {
      type: "UPDATE_CAPABILITIES",
      agentId: "skeptic",
      capabilities: ["code_execution", "file_write", "http_request"],
    },
  ];

  /**
   * The only legal way to permit capability mutation at all: the type is
   * allowed *and* approval is required. Pairing it with
   * humanApprovalRequired:false is rejected at genome validation, which is the
   * outer of two independent defenses — see the genome suite. This suite
   * exercises the inner one, at apply time.
   */
  const withCapabilityMutation = () => {
    const g = structuredClone(BALANCED_ANALYSIS);
    g.mutationPolicy = {
      humanApprovalRequired: true,
      allowed: ["UPDATE_CAPABILITIES", "UPDATE_PROMPT"],
    };
    return parseGenome(g);
  };

  it("blocks a watcher granting itself capabilities", () => {
    expect(() =>
      applyPatches(withCapabilityMutation(), escalating(), { actor: "WATCHER" }),
    ).toThrow(MutationPolicyError);
  });

  it("names privilege widening as the reason, not just missing approval", () => {
    try {
      applyPatches(withCapabilityMutation(), escalating(), { actor: "WATCHER" });
      expect.unreachable("watcher capability grant must be rejected");
    } catch (error) {
      expect((error as Error).message).toMatch(/widen the organization's permissions/);
    }
  });

  it("allows the same capability grant from a human", () => {
    const { genome: after } = applyPatches(withCapabilityMutation(), escalating(), {
      actor: "HUMAN",
    });
    expect(after.agents.find((a) => a.id === "skeptic")!.capabilities).toContain(
      "code_execution",
    );
  });

  it("allows a watcher capability grant that a human explicitly approved", () => {
    const { genome: after } = applyPatches(withCapabilityMutation(), escalating(), {
      actor: "WATCHER",
      humanApproved: true,
    });
    expect(after.agents.find((a) => a.id === "skeptic")!.capabilities).toContain("file_write");
  });

  it("blocks a watcher reconfiguring its own evaluation model", () => {
    const g = structuredClone(BALANCED_ANALYSIS);
    g.mutationPolicy = { humanApprovalRequired: true, allowed: ["CHANGE_WATCHER"] };
    expect(() =>
      applyPatches(
        parseGenome(g),
        [{ type: "CHANGE_WATCHER", watcher: { enabled: false } }],
        { actor: "WATCHER" },
      ),
    ).toThrow(/widen the organization's permissions/);
  });
});

describe("diffing", () => {
  it("reports an empty diff for an unchanged genome", () => {
    const g = loadTemplate("balanced-analysis");
    expect(isEmptyDiff(diffGenomes(g, g))).toBe(true);
  });

  it("reports protocol changes with before and after values", () => {
    const before = permissive();
    const { genome: after } = applyPatches(
      before,
      [{ type: "CHANGE_PROTOCOL", protocols: { maxRounds: 3 } }],
      { actor: "HUMAN" },
    );
    const diff = diffGenomes(before, after);
    expect(diff.protocolChanges).toContainEqual({ key: "maxRounds", from: 1, to: 3 });
  });

  it("reports added and removed agents and edges", () => {
    const before = permissive();
    const { genome: after } = applyPatches(
      before,
      [
        newAgent("newcomer"),
        { type: "ADD_EDGE", edge: { from: "newcomer", to: "empiricist", interaction: "challenge", weight: 1 } },
      ],
      { actor: "HUMAN" },
    );
    const diff = diffGenomes(before, after);
    expect(diff.agentsAdded).toEqual(["newcomer"]);
    expect(diff.edgesAdded).toEqual(["newcomer -challenge-> empiricist"]);
    expect(isEmptyDiff(diff)).toBe(false);
  });
});
