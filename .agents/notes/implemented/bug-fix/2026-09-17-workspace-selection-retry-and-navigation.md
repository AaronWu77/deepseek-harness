# Agent Note: Workspace selection remains recoverable across navigation races

Status: implemented

English | [中文](2026-09-17-workspace-selection-retry-and-navigation.zh.md)

## Problem

The Conversation treated a rejected or superseded Workspace selection as an ordinary completion: it cleared the only visible target label on failure, and startup auto-selection could commit after a manual selection had begun.

## Decision

`uiWorkspace.openWorkspace` commits only while its navigation signal is current. `replaceMain` re-checks that signal after the optional synchronous preparation callback and releases the retained reference when navigation superseded the request, so a superseded call may still create a Session but never selects it or moves a draft. Startup auto-selection opens through the same method and therefore the same layout navigation signal, so its late result cannot overwrite a manual choice. [ConversationContent](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx) holds the picked Workspace as pending state and rolls it back when the selection callback rejects, so the previously selected label stays visible. The shell offers no separate retry control: the picker remains and the user selects again.

## Alternatives considered

**Clearing the pending label on every failure** hides the target while the selection is still settling. **Leaving startup auto-selection uncancelled** lets a late automatic result overwrite a manual choice, so both flows share the layout cancellation signal.

## Consequences

A rejected selection keeps the previously selected label visible; a superseded request leaves its created Session available without selecting it. The selection callback and `openWorkspace` are `Promise<void>`: callers observe failure through rejection rather than a result flag.

## Verification

Conversation tests cover the pending state, success before the Workspace membership refresh, and the rollback on rejection. Workspace service tests cover the commit rule and cancellation of startup auto-selection by manual navigation.
