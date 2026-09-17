# Agent Note: Retired preset defaults recover after the code-to-PTC rename

Status: implemented

English | [中文](2026-09-17-retired-preset-default-recovery.zh.md)

## Problem

The pre-release rename changed the shipped preset id `code` to `ptc` without a compatibility alias. The settings namespace persisted a user's selected default across upgrades, so a document retaining `default: code` made every unnamed Session creation fail with `agent-preset/not-found`. In Web this happened after a Workspace click, leaving the composer at Workspace selection.

## Decision

When mode selection is enabled, `AgentPresets` reads a saved default of exactly `code` as `ptc`, the renamed shipped preset. This is a settings-only recovery: `code` is not added to the roster, and an explicit `resolve('code')` still follows normal unknown-id handling. Other unknown saved defaults still fail when a Session tries to use them; deployment defaults and mode-disabled selection are unchanged.

The [released Session-format migration](../architecture/2026-08-31-released-session-format-migrations.md) continues to own `code` to `ptc` conversion in Session headers and selection events; this note covers the separate user-settings layer.

## Alternatives considered

**Add `code` as a roster alias** would make the retired identifier part of the current preset API and could expose two names for one composition, so the roster remains PTC-only. **Fall back every missing saved default to the deployment default** would hide live-directory or authoring mistakes, so only the known renamed value is recovered. **Rewrite the settings file only during startup** would leave a race before that asynchronous write commits, so default resolution itself handles the old value before Session composition.

## Consequences

Users upgrading from the old preset vocabulary can create new Sessions without manually editing their settings file, and the roster marks `ptc` as the effective default. The old saved text may remain until the user chooses another default; explicit old ids and unrelated missing ids remain errors.

## Verification

The agent-preset settings test covers roster marking, Session composition, and rejection of an explicit retired id after the migration.
