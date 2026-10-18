---
kind: upgrade-guide
description: "Personal branding and Aurora colors require an optional skin bundle instead of Host defaults."
---
# Personal skin bundle

English | [中文](guide.zh.md)

## Change

This customized Host uses the upstream fish/local-build sidebar fallback and neutral default colors. AW/STUDIO branding, Aurora glass/ink colors, and the StateDot running glyph are owned by the optional `dsh-skin` bundle. Without the skin, Chat uses the upstream whale glyph; elapsed time remains Host-owned. Existing Session data, tools, permissions and model selection are unchanged.

## Migration

Before deploying the companion Host, build and install `dsh-skin` into the Web profile through `dsh plugin --profile web add link:<plugin-path>`. Use the plugin’s stopped-service migration instructions to back up the profile, build the Host and plugin, then restart from the primary Host workspace. Do not merely load the skin into the old customized Host: some colors would remain duplicated and the brand scale would differ.

Update the Host and skin together before restarting to enable the running-icon Slot. Disabling the skin removes its personal brand, running-glyph registration and stylesheet, restoring the whale without resetting the clock; it leaves the Host’s functional geometry, floating-pane fixes and native chrome intact. Subsequent skin-only development can use the plugin’s build watcher with the existing Web HMR receiver.
