import { demoInputs, demoPipeline } from "../pipelines/demo";
import { jitDemoInputs, jitDemoPipeline } from "../pipelines/jit-demo";
import {
  preflightDemoInputs,
  preflightDemoPipeline,
} from "../pipelines/preflight-demo";
import {
  reviewLoopDemoInputs,
  reviewLoopDemoPipeline,
} from "../pipelines/review-loop-demo";
import { stepsDemoInputs, stepsDemoPipeline } from "../pipelines/steps-demo";
import {
  suspensionDemoInputs,
  suspensionDemoPipeline,
} from "../pipelines/suspension-demo";
import {
  ticketReviewDemoInputs,
  ticketReviewDemoPipeline,
} from "../pipelines/ticket-review-demo";
import {
  worktreeDemoInputs,
  worktreeDemoPipeline,
} from "../pipelines/worktree-demo";
import type { AnyPipelineEntry } from "./factory";

const entries = {
  "demo-crash": {
    pipeline: demoPipeline,
    inputs: demoInputs,
    hookToken: (triggerId) => `demo:${triggerId}`,
  },
  "steps-demo": {
    pipeline: stepsDemoPipeline,
    inputs: stepsDemoInputs,
    hookToken: (triggerId) => `steps:${triggerId}`,
  },
  // Resume tokens are resource-scoped (linear:ticket:<uuid>, github:pr:...),
  // derived from inputs rather than the triggerId, so no hookToken here.
  "suspension-demo": {
    pipeline: suspensionDemoPipeline,
    inputs: suspensionDemoInputs,
  },
  "ticket-review-demo": {
    pipeline: ticketReviewDemoPipeline,
    inputs: ticketReviewDemoInputs,
    requires: { harnesses: ["claude"] },
  },
  "jit-demo": {
    pipeline: jitDemoPipeline,
    inputs: jitDemoInputs,
    requires: { harnesses: ["claude"] },
  },
  "preflight-demo": {
    pipeline: preflightDemoPipeline,
    inputs: preflightDemoInputs,
    requires: { bindings: ["api"], harnesses: ["claude"] },
  },
  "review-loop-demo": {
    pipeline: reviewLoopDemoPipeline,
    inputs: reviewLoopDemoInputs,
    requires: { bindings: ["scratch"], harnesses: ["claude"] },
  },
  "worktree-demo": {
    pipeline: worktreeDemoPipeline,
    inputs: worktreeDemoInputs,
    hookToken: (triggerId) => `worktree:${triggerId}`,
    requires: { bindings: ["scratch"] },
  },
} satisfies Record<string, AnyPipelineEntry>;

export const registry: Record<string, AnyPipelineEntry> = entries;
