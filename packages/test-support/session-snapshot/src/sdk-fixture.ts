/** Native-cwd materialization for private TypeScript SDK replay fixtures. */
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

const CWD = '{{cwd}}'
const JSON_STRING_OR_CWD = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|\{\{cwd\}\}/g

/** Collect each marker's replacement, escaped once per containing JSON string literal. */
function* cwdReplacements(text: string, cwd: string): Generator<string> {
  for (const [literal] of text.matchAll(JSON_STRING_OR_CWD)) {
    if (literal === CWD) {
      yield cwd
    } else if (literal.includes(CWD)) {
      const decoded = JSON.parse(literal) as string
      if (literal.split(CWD).length !== decoded.split(CWD).length) {
        throw new Error('SDK replay cwd marker count changed during JSON decoding')
      }
      for (const replacement of cwdReplacements(decoded, cwd)) {
        yield JSON.stringify(replacement).slice(1, -1)
      }
    }
  }
}

/**
 * Materialize cwd tokens in SDK JSONL without changing bytes outside the markers.
 * Quoted cwd tokens follow JSON string-literal encoding, including runtime-context paths;
 * arbitrary prose quotation and JavaScript string syntax are not alternate encodings.
 * @param rawLog - committed JSONL copied into the SDK scenario's private workspace.
 * @param cwd - native working directory of that workspace.
 * @returns validated replay input, preserving other bytes and every JSON string's escaping depth.
 * @throws before SDK boot when JSON decoding introduces cwd markers or the materialized Session fails replay parsing.
 */
export function materializeSdkReplayFixtureCwd(rawLog: string, cwd: string): string {
  const replacements = [...cwdReplacements(rawLog, cwd)]
  let index = 0
  const materialized = rawLog.replaceAll(CWD, () => replacements[index++] as string)
  parseSessionLog(materialized)
  return materialized
}
