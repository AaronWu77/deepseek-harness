---
kind: upgrade-guide
description: "PI-AI rejects completed responses with malformed tool arguments instead of allowing an empty argument object to reach tools."
---

# PI-AI rejects malformed tool arguments

English | [中文](guide.zh.md)

## Change

PI-AI 1.4.0 marks completed tool calls whose arguments cannot be parsed as a JSON object. The DSH PI-AI adapter reports `INVALID_REQUEST` for such a response before executing any tool in that response. It does not substitute an empty argument object or execute an earlier valid tool call from the same response.

Responses stopped by the output limit retain their existing `max-tokens` handling. This change does not migrate stored conversations or change tool schemas.

## Migration

1. If a PI-AI response fails with `INVALID_REQUEST` and a tool-argument error, correct the generated arguments so they form a complete JSON object, then retry the turn. Do not treat malformed arguments as `{}` in a custom retry handler.
2. Integrations that consume streaming output must wait for the terminal result before dispatching tools. A tool-call end event alone does not establish that the response succeeded.
3. Confirm that malformed, truncated-without-an-output-limit, and non-object tool arguments produce an error without tool side effects. Valid arguments and responses stopped by the output limit retain their normal handling.
