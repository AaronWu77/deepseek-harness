/** Structured RG refusals are separate from unknown infrastructure failures. */
import { HarnessError } from '@deepseek-ai/dsh-llm'

import type { RgErrorCode } from './types.ts'

/** Expected role, budget, or Session-policy refusal. */
export class RgError extends HarnessError {
  declare readonly code: RgErrorCode
  /** @param code - stable refusal category. @param message - safe explanation and next action. */
  constructor(code: RgErrorCode, message: string) { super(message, code); this.name = 'RgError' }
}
