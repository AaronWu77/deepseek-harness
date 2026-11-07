---
kind: upgrade-guide
description: "The PI-AI 1.4.0 bundled catalog retires older Codex model IDs and updates native tool-declaration behavior."
---

# PI-AI 1.4.0 model catalog

English | [中文](guide.zh.md)

## Change

The bundled PI-AI catalog no longer lists `openai-codex/gpt-5.5` or `openai-codex/gpt-5.5-spark`. Profiles that rely on those bundled entries must select a model supported by their provider. Explicit profile model declarations and external plugin catalogs retain their own ownership; the upgrade does not rewrite user configuration.

Models such as `openai-codex/gpt-6.1-sol` use native incremental tool declarations. Their initial and subsequent tools appear in `additional_tools` conversation items; request inspectors must not assume that initial tools appear only in the top-level `tools` field. The SDK owns these wire-format and cache-prefix choices.

## Migration

1. Check configured model IDs against the upgraded provider catalog and the account's actual model access. Replace retired bundled IDs with an available model; do not infer account access from a bundled entry alone.
2. Update custom wire-request assertions for native incremental tool declarations. The DSH tool registry and public tool schemas do not require migration.
3. Verify tool additions, removals, and model switches through the PI-AI conversation-update and replay regressions before changing a deployed provider.
