# Agent Note: Workspace selection remains recoverable across navigation races

Status: implemented

English | [中文](2026-09-17-workspace-selection-retry-and-navigation.zh.md)

## Problem

The Conversation treated a rejected or superseded Workspace selection as an ordinary completion. It cleared the only visible target label on failure, left a cold-start composer locked without a recovery action, and allowed startup auto-selection to commit after a manual selection had begun.

## Decision

`uiWorkspace.openWorkspace` resolves `true` only after it commits the Session opening and resolves `false` when navigation supersedes the request. Startup auto-selection uses the layout navigation signal, so manual navigation invalidates its late result. ConversationContent keeps the selected Workspace label while the Session and Workspace projections settle, keeps input inert during pending or failed selection, shows a localized retry action after failure, and enables input as soon as the open commits. A request identity ignores stale asynchronous completions.

## Alternatives considered

**Clearing the pending label on every failure** hides the target and leaves a cold-start user with no recovery path, so the failed selection remains visible with an explicit retry. **Waiting for Workspace membership before enabling input** keeps the composer locked during a successful open when the list projection lags, so the committed open is the enablement event. **Leaving startup auto-selection uncancelled** lets a late automatic result overwrite a manual choice, so both flows share the layout cancellation signal.

## Consequences

Workspace selection failures are visible and retryable without rebuilding the page. Consumers of `openWorkspace` and the injected `selectWorkspace` callback can distinguish an opened Session from a superseded request. A superseded request may still leave its created Session available, but it cannot move drafts or select the late result.

## Verification

Conversation tests cover pending state, success before Workspace membership refresh, failure visibility, and retry. Workspace service tests cover the boolean result and cancellation of startup auto-selection by manual navigation.
