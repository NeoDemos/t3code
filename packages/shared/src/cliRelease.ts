const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

/**
 * Kept in step with the build_linux_cli matrix, build_windows_arm64_cli, and
 * the `cli_archive` rows in .github/workflows/release.yml: a key here without a
 * build there produces download URLs that 404, and a build there without a key
 * here is unreachable from every installer.
 */
// No darwin-x64: Node single-executables are unsupported on x64 macOS (the
// SEA docs list macOS as arm64 only) and the binary segfaults on start.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * Windows ships bsdtar in System32, which reads both formats; a Git-for-Windows
 * GNU tar earlier on PATH cannot open the zip, so the system copy is named by
 * absolute path.
 */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/**
 * release.yml moves a channel's dist-tag only after that version's GitHub release exists, so the
 * tags are the index of each channel's newest release. Moving one by hand moves every installer.
 */
export const CLI_RELEASE_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/t3/dist-tags";

const CLI_RELEASE_DIST_TAG = {
  stable: "latest",
  nightly: "nightly",
  preview: "preview",
} satisfies Record<CliReleaseChannel, string>;

/**
 * A tag that points at another channel's build is ignored, so a mistyped
 * `npm dist-tag add` cannot move stable installs onto a nightly.
 */
export function cliReleaseVersionFromDistTags(
  distTags: Readonly<Record<string, string>>,
  channel: CliReleaseChannel,
): string | undefined {
  const version = distTags[CLI_RELEASE_DIST_TAG[channel]];
  return version !== undefined &&
    /^\d+\.\d+\.\d+(?:-(?:nightly|preview)\.\d{8}\.\d+)?$/.test(version) &&
    cliReleaseChannelOf(version) === channel
    ? version
    : undefined;
}
