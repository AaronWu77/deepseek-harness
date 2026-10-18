---
kind: upgrade-guide
description: "Personal branding and Aurora colors require an optional skin bundle instead of Host defaults."
---
# Personal skin bundle

English | [中文](guide.zh.md)

## Change

This customized Host uses the upstream fish/local-build sidebar fallback and neutral default colors. AW/STUDIO branding, Aurora glass/ink colors, and the StateDot running glyph are owned by the optional `dsh-skin` bundle. Without the skin, Chat uses the upstream whale glyph; elapsed time remains Host-owned. Existing Session data, tools, permissions and model selection are unchanged.

## Migration

For an old customized Host, follow the [skin deployment instructions](https://github.com/AaronWu77/dsh-skin/blob/main/DEPLOY.md) to stop the service, back up the profile, build the companion Host and plugin, install the bundle through `dsh plugin --profile web add link:<plugin-path>`, and restart from that Host checkout. Do not merely load the skin into the old customized Host: some colors would remain duplicated and the brand scale would differ. An already migrated Host with the bundle installed uses the same document’s regular-update section; do not repeat the first migration or reinstall unrelated plugins.

Update the Host and skin together before restarting to enable the running-icon Slot. Disabling the skin removes its personal brand, running-glyph registration and stylesheet, restoring the whale without resetting the clock; it leaves the Host’s functional geometry, floating-pane fixes and native chrome intact. Skin-only development follows the plugin README’s [hot-reload requirements](https://github.com/AaronWu77/dsh-skin/blob/main/README.md#development-and-hot-reload); a watcher alone does not guarantee that the active GUI updates.
