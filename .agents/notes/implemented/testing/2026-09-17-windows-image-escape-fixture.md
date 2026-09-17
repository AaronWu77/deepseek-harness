# Agent Note: Windows-safe fixtures for repository image escape checks

Status: implemented

English | [中文](2026-09-17-windows-image-escape-fixture.zh.md)

## Problem

The negative `publishableImage` test created a file symbolic link from the repository fixture to an outside file. Windows requires Developer Mode or elevated permission for that operation, so the documentation gate could fail before it reached the repository-escape assertion.

## Decision

The fixture creates the outside file, links the outside directory under the repository with a directory junction on Windows and a directory symbolic link elsewhere, then addresses the file through that linked directory. The production check still resolves the file's real path and must reject it because the resolved path is outside the repository. The direct outside-file assertion remains alongside the linked-path assertion.

## Alternatives considered

**Require Developer Mode or administrator permission.** Rejected: a test fixture should not require a host policy unrelated to the path-ownership rule.

**Skip the escape case on Windows.** Rejected: the negative assertion protects the documentation publisher from copying files outside the repository and must run on the platform where the original fixture failed.

**Mock `realpathSync` or the production helper.** Rejected: a mock would avoid the permission failure but would no longer exercise the real path resolution that enforces the safety rule.

## Consequences

The documentation-site test uses the same directory-link primitive already used by other Windows-safe repository fixtures. It verifies the relevant directory traversal and real-path escape behavior without privileged file-link creation; file-symbolic-link handling remains supported by the production implementation when the host permits that link type.

## Verification

`scripts/project-doc-site.spec.ts` covers both the linked file path and the direct outside file, while `pnpm run doc-sync` includes this suite in the documentation-site checks.
