---
kind: upgrade-guide
description: "Personal branding and Aurora colors require an optional skin bundle instead of Host defaults."
---
# Personal skin bundle

English | [中文](guide.zh.md)

## Change

This customized Host uses the upstream fish/local-build sidebar fallback and neutral default colors. AW/STUDIO branding and Aurora glass/ink colors are owned by the optional `dsh-skin` bundle. Existing Session data, tools, permissions and model selection are unchanged.

## Migration

Before deploying the companion Host, build and install `dsh-skin` into the Web profile through `dsh plugin --profile web add link:<plugin-path>`. Use the plugin’s stopped-service migration instructions to back up the profile, build the Host and plugin, then restart from the primary Host workspace. Do not merely load the skin into the old customized Host: some colors would remain duplicated and the brand scale would differ.

Disabling the skin removes its personal brand registrations and stylesheet; it leaves the Host’s functional geometry, floating-pane fixes, native chrome and running indicator intact. Subsequent skin-only development can use the plugin’s build watcher with the existing Web HMR receiver.
