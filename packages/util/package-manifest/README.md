---
description: "Shared TypeScript declarations for package identity, runtime requirements, and DSH plugin metadata."
kind: "package-library"
---

# @deepseek-ai/dsh-package-manifest

English | [中文](README.zh.md)

## Summary

Use `DshPackageManifest` for package metadata, `DshManifest` for the public fields under `dsh`, and member types such as `DshClientManifest` for one domain. Each reader owns JSON parsing, validation, and default resolution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import from the package root. Use a development dependency when only checking your own source; use a production dependency if your published declarations reference these types.

```ts
import type { DshClientManifest, DshPackageManifest } from '@deepseek-ai/dsh-package-manifest'

const client: DshClientManifest = { platform: 'web' }
const manifest: DshPackageManifest = {
  name: 'example-dsh-plugin',
  version: '1.0.0',
  engines: { node: '>=24', dsh: '0.1.5-alpha.1' },
  dsh: {
    manifestVersion: 1,
    bundle: { patch: './cordis.patch.yml' },
    client,
  },
}
```

`DshPackageManifest` describes the package.json fields used by DSH, with required `name` and `version`; it is not an exhaustive npm schema. Local profile readers use `Partial<DshPackageManifest>` because profiles need no published version. `DshManifest` describes only public author fields under `dsh`. `DshBundleManifest.patch` is one patch file path or an ordered list of them, each relative to the package root; the launcher applies a list in order as one bundle layer. TypeScript checks the example and erases `import type`; these interfaces do not parse JSON or write a file.

The following metadata fields are optional. Omitting them leaves the format version or compatible host versions undeclared; readers do not infer defaults.

| Field | Meaning |
|---|---|
| `dsh.manifestVersion` | Manifest format identifier; the declared format is `1`, independent of the npm package version and Session format version. |
| `engines.dsh` | Author-declared compatible DSH versions as a SemVer range, including exact prerelease versions. This field sits beside `engines.node` and `engines.npm`; an engines object may omit `dsh`. |

`LocalizedText` carries literal text or a language map with a required English fallback. `PluginLocalizedMeta` carries optional display title, description, an image data URL resolved from a package root's `package.json.icon` or an exported `<specifier>/icon`, optional `package` details, and metadata diagnostics for installed plugins. [App boot](../../boot/app-boot/README.md) reads these values; this package only supplies their types.

<a id="package-details-and-upstream-declarations"></a>
### Package details and upstream declarations

`PluginPackageDetails` is the validated value of `PluginLocalizedMeta.package`. The declarations belong to the plugin's own exported package-root manifest; a subpath plugin does not inherit them from its parent package or bundle. Missing fields remain unknown, and missing upstreams never establish original authorship.

| Manifest declaration | Validated package detail |
|---|---|
| `repository` | A URL string or npm repository object becomes `{ url, directory? }`; `directory` identifies a relative directory without traversal and remains separate from the link. |
| `license`, `homepage` | The declared package license and project homepage; neither describes an upstream project. |
| `author`, `maintainers` | Author text and a separate maintainer text list; npm person objects contribute their `name`. The reader does not infer maintainers from the author or turn people into links. |
| `dsh.documentation` | An explicit public documentation URL, either a string or a language map with lowercase language ids and a nonblank `en` fallback. The reader does not infer a branch or README URL. |
| `dsh.upstreams` | An array of `PluginUpstream` declarations, separate from the current package repository and installation source. |

Each upstream declares `name`, `repository`, and `relation`: `copied`, `adapted`, `patched`, `integration`, or `reference`. Copied, adapted, and patched code require the upstream `license` and a nonblank `changes` summary. `changes` accepts literal text or the same localized form as documentation. Optional `ref` records the upstream revision or release; omission means the baseline is not recorded, not that the reader may infer one. Optional `record` links a public detailed source record. Preserve original attribution and license notices when documenting reused code; these declarations do not replace them or certify safety.

Package links accept HTTP(S) without credentials. Repository links also accept `git+http`/`git+https` and normalize them to web URLs, but reject queries; SSH addresses, local paths, and executable URLs are not supported. [App boot](../../boot/app-boot/README.md#reading-plugin-display-metadata) owns validation limits and diagnostics.

The Plugin Manager projects `packageSource: "package" | "catalog"` beside `package` to identify the selected declaration source. This Host field is not an author declaration. Readable installed declarations remain available even when compatibility checks reject activation; catalog declarations are identified independently of whether an installation target is available.

Public composition declarations are defined in [`src/types.ts`](src/types.ts). Internal `configTrees`, `sessionFormatMigration`, and generated `moduleFallback` metadata remain owned by their image-packer, catalog, and launcher readers; the public types do not expose them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package root only re-exports declarations from [`src/types.ts`](src/types.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Profile launcher](../../boot/app-boot/README.md#profiles) — manifest loading and composition.
- [Public package metadata](../../../.agents/notes/implemented/architecture/2026-09-10-public-package-manifest.md) — field placement and reader ownership.

<a id="model-experience"></a>
## Model Experience

None, as this package only exports types.

#### KV Cache effect

Type declarations add no model input, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Static typing only.** Consumers read and validate the JSON fields they use, then adapt the shared declarations to their runtime data. The package supplies no parser, getter helpers, file checks, or defaults.
- **Compatibility is declarative.** Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
