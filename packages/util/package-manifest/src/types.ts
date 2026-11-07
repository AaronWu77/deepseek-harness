/**
 * Shared declarations for package.json fields and plugin display metadata.
 * Each reader owns JSON validation and resolved defaults.
 * @module @deepseek-ai/dsh-package-manifest/types
 */

/** Package identity and metadata; local profile readers may accept a partial declaration. */
export interface DshPackageManifest {
  /** Published npm package name. */
  name: string
  /** Published npm package version. */
  version: string
  /** Package summary for discovery and display. */
  description?: string
  /** Current package repository; Git HTTP(S) transports normalize to web links when read. */
  repository?: string | { type?: string; url: string; directory?: string }
  /** Project homepage, distinct from documentation. */
  homepage?: string
  /** Declared package license expression or identifier. */
  license?: string
  /** npm author declaration, distinct from current maintainers. */
  author?: string | { name: string; email?: string; url?: string }
  /** npm maintainer declarations. */
  maintainers?: readonly (string | { name: string; email?: string; url?: string })[]
  /** SVG, PNG, JPEG, or WebP file relative to this manifest's directory, at most 256 KiB and contained there after realpath resolution. */
  icon?: string
  /** Prevent npm publication, for example for local profile projects. */
  private?: boolean
  /** Packages installed alongside this package. */
  dependencies?: Record<string, string>
  /** Packages that may be absent when installation or platform checks skip them. */
  optionalDependencies?: Record<string, string>
  /** Compatible versions of packages supplied by the consuming project. */
  peerDependencies?: Record<string, string>
  /** Runtime requirements; DSH compatibility is declarative until a reader enforces it. */
  engines?: DshEnginesManifest
  /** DSH-specific author declarations. */
  dsh?: DshManifest
}

/** Public author fields under `package.json.dsh`; a package may declare several roles. */
export interface DshManifest {
  /** Manifest format version, independent of the npm package and Session format versions. */
  manifestVersion?: 1
  /** Explicit public HTTP(S) documentation links, with an English fallback for translations. */
  documentation?: LocalizedText
  /** Declared upstream projects; omission makes no claim about code authorship. */
  upstreams?: readonly PluginUpstream[]
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
  /** Client module loading and build metadata. */
  client?: DshClientManifest
}

/** Literal text or translations indexed by lowercase language id, with a required English fallback. */
export type LocalizedText = string | { readonly en: string; readonly [locale: string]: string }

/** A package author's explicit relationship to an upstream project, not the current package repository. */
export interface PluginUpstream {
  /** Upstream project display name. */
  readonly name: string
  /** Public HTTP(S) repository URL, normalized from Git HTTP(S) transports if needed. */
  readonly repository: string
  /** Declared code reuse or integration relationship. */
  readonly relation: 'copied' | 'adapted' | 'patched' | 'integration' | 'reference'
  /** Recorded upstream revision or release; omission means the baseline is not recorded. */
  readonly ref?: string
  /** Upstream license; required for copied, adapted, and patched code. */
  readonly license?: string
  /** Local changes; required for copied, adapted, and patched code, with nonblank English fallback. */
  readonly changes?: LocalizedText
  /** Public HTTP(S) evidence link; never a local file path. */
  readonly record?: string
}

/** Validated package-root declarations; absent fields are unknown, not claims of original authorship. */
export interface PluginPackageDetails {
  /** Current package repository and optional package-relative directory. */
  readonly repository?: { readonly url: string; readonly directory?: string }
  /** Public project homepage. */
  readonly homepage?: string
  /** Explicit public documentation links; no branch or filename is inferred. */
  readonly documentation?: LocalizedText
  /** Declared package license. */
  readonly license?: string
  /** Declared npm author, displayed as text rather than a link. */
  readonly author?: string
  /** Declared npm maintainers, displayed as text rather than links; never inferred from author. */
  readonly maintainers?: readonly string[]
  /** Declared upstream relationships; omission makes no authorship claim. */
  readonly upstreams?: readonly PluginUpstream[]
}

/** Validated plugin display fields and diagnostics from exported locales, manifests, or icon files. */
export interface PluginLocalizedMeta {
  /** Display title; omission preserves the consumer's technical-name fallback. */
  readonly title?: LocalizedText
  /** Display introduction after locale and package-field fallback. */
  readonly description?: LocalizedText
  /** Base64 image data URL from a package root's manifest icon or an exported `<specifier>/icon`; render as an image, not inline markup. */
  readonly icon?: string
  /** Validated declarations from this plugin's own package-root manifest; absent for subpaths or invalid declarations. */
  readonly package?: PluginPackageDetails
  /** Host-selected origin of package details; never inferred from installation or activation errors. */
  readonly packageSource?: 'package' | 'catalog'
  /** Unmodified local metadata diagnostic; the plugin remains manageable. */
  readonly error?: string
}

/** Runtime version requirements under `package.json.engines`. */
export interface DshEnginesManifest {
  /** Compatible DSH versions as a SemVer range, including an exact version. */
  dsh?: string
  /** Compatible Node.js versions. */
  node?: string
  /** Compatible npm versions. */
  npm?: string
  /** Requirements for additional runtimes or package managers. */
  [engine: string]: string | undefined
}

/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
  /** Supported Node Host platform names; omission allows every operating system. */
  platforms?: string[]
  /** One patch file path, or an ordered list applied in sequence, each relative to the declaring package root. */
  patch: string | string[]
  /** Show the bundle in GUI lists before the profile enables or installs it; omission means true. */
  listedByDefault?: boolean
}

/** The bundle composition declared by a profile directory. */
export interface DshProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[]
}

/** Client module declaration read by client-modules and the client build. */
export interface DshClientManifest {
  /** Client platform identifier; the Web consumer selects `web`. */
  platform: string
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[]
  /** Boot phase-one registration barrier; absent means the shared application batch. */
  immediately?: boolean
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[]
}
