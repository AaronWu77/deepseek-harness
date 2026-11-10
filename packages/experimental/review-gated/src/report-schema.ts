/** Deployment-owned JSON Schemas for final role reports under PTC. */
import type { ObjectJsonSchema, JsonSchemaNode } from '@deepseek-ai/dsh-tools'

const text: JsonSchemaNode = { type: 'string', minLength: 1 }
const list: JsonSchemaNode = { type: 'array', items: text }
/** Schema demanded from a fresh worker; no model-supplied run identity is accepted. */
export const workerOutputSchema: ObjectJsonSchema = {
  type: 'object', additionalProperties: false, required: ['kind', 'outcome', 'summary', 'changes', 'validation', 'unverified'],
  properties: { kind: { type: 'string', const: 'worker' }, outcome: { type: 'string', enum: ['completed', 'partial', 'blocked'] },
    summary: text, changes: list, validation: list, unverified: list },
}
/** Reviewer schema; the RG owner additionally validates verdict/finding consistency. */
export const reviewerOutputSchema: ObjectJsonSchema = {
  type: 'object', additionalProperties: false, required: ['kind', 'verdict', 'summary', 'inspectedScope', 'findings', 'validation', 'unverified'],
  properties: { kind: { type: 'string', const: 'reviewer' }, verdict: { type: 'string', enum: ['pass', 'changes-requested', 'inconclusive'] },
    summary: text, inspectedScope: list, validation: list, unverified: list,
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['location', 'impact', 'evidence'],
      properties: { location: text, impact: text, evidence: text } } } },
}
