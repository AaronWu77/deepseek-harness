/** Strict JSON validation at RG configuration, model, and persistence inputs. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RgRunId, RgTaskId } from './types.ts'

export { modelSchema, poolSchema, settingsSchema } from './settings-schema.ts'
import { modelSchema, poolSchema } from './settings-schema.ts'
const text = z.string().trim().min(1)
const list = z.array(text)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** Immutable per-Session policy. */
export const policySchema = z.object({
  version: z.literal(1), configurationHash: text,
  main: poolSchema, worker: poolSchema, reviewer: poolSchema, reviewerInherited: z.boolean(),
  maxWorkerAttempts: positive, maxReviewAttempts: positive,
  maxHandoffChars: positive, maxReportChars: positive, maxScopeFiles: positive, maxScopeBytes: positive,
}).strict().superRefine((policy, context) => {
  for (const role of ['main', 'worker', 'reviewer'] as const) {
    if (policy[role].candidates.length === 0 || policy[role].default === null) context.addIssue({ code: 'custom', path: [role], message: 'A frozen policy requires candidates and a default for every role.' })
  }
})
/** Fresh role requirements, bounded as one serialized document by the owner. */
export const handoffSchema = z.object({
  objective: text, acceptance: list.min(1), scope: list.min(1), constraints: list, facts: list, validation: list,
}).strict()
/** Formal worker report. */
export const workerReportSchema = z.object({
  kind: z.literal('worker'), outcome: z.enum(['completed', 'partial', 'blocked']),
  summary: text, changes: list, validation: list, unverified: list,
}).strict()
/** Formal reviewer verdict with concrete findings. */
export const reviewReportSchema = z.object({
  kind: z.literal('reviewer'), verdict: z.enum(['pass', 'changes-requested', 'inconclusive']),
  summary: text, inspectedScope: list.min(1),
  findings: z.array(z.object({ location: text, impact: text, evidence: text }).strict()),
  validation: list, unverified: list,
}).strict().superRefine((report, context) => {
  if (report.verdict === 'pass' && report.findings.length > 0) context.addIssue({ code: 'custom', message: 'A pass cannot carry blocking findings.' })
  if (report.verdict === 'changes-requested' && report.findings.length === 0) context.addIssue({ code: 'custom', message: 'Changes requested requires an evidence-based finding.' })
})
/** Checked file-scope identity. */
export const scopeSchema = z.object({
  root: text, paths: list, fingerprint: text.nullable(), diagnostic: text.nullable(), capturedAt: z.number(),
}).strict()
/** Budgeted role execution state. */
export const runSchema = z.object({
  id: text.transform(brandString<RgRunId>), childId: text.transform(SessionId), role: z.enum(['worker', 'reviewer']),
  workRevision: z.number().int().nonnegative(), selection: modelSchema,
  status: z.enum(['reserved', 'running', 'saving', 'completed', 'failed', 'cancelled', 'interrupted']),
  report: z.union([workerReportSchema, reviewReportSchema]).nullable(), diagnostic: text.nullable(), scope: scopeSchema.nullable(),
}).strict()
/** Bounded latest-task state. */
export const taskSchema = z.object({
  id: text.transform(brandString<RgTaskId>), originMessageId: text.transform(brandString<MessageId>), objective: text,
  workRevision: z.number().int().nonnegative(),
  workerAttempts: z.number().int().nonnegative(),
  reviewAttempts: z.number().int().nonnegative(),
  active: runSchema.nullable(), lastWorker: runSchema.nullable(), lastReview: runSchema.nullable(),
  reviewStatus: z.enum(['not-reviewed', 'reviewing', 'reported-pass', 'changes-requested', 'inconclusive', 'stale']),
}).strict()
/** Complete checkpoint-safe state carried by every RG state event. */
export const sessionStateSchema = z.object({
  priorModel: modelSchema.nullable().exactOptional(),
  policy: policySchema.nullable(), role: z.enum(['main', 'worker', 'reviewer']),
  parentSessionId: text.transform(SessionId).nullable(), taskId: text.transform(brandString<RgTaskId>).nullable(),
  runId: text.transform(brandString<RgRunId>).nullable(), task: taskSchema.nullable(), diagnostic: text.nullable(),
}).strict()
