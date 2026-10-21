import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseVersionFromDistTags,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("reads each channel's version from npm dist-tags and ignores a tag on the wrong channel", () => {
    const distTags = {
      alpha: "0.0.2",
      latest: "1.2.3",
      nightly: "1.2.4-nightly.20260912.7",
      preview: "1.2.4-preview.20260912.8",
    };
    expect(cliReleaseVersionFromDistTags(distTags, "stable")).toBe("1.2.3");
    expect(cliReleaseVersionFromDistTags(distTags, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(cliReleaseVersionFromDistTags(distTags, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(
      cliReleaseVersionFromDistTags({ latest: "1.2.4-nightly.20260912.7" }, "stable"),
    ).toBeUndefined();
    expect(cliReleaseVersionFromDistTags({ latest: "1.2.3" }, "nightly")).toBeUndefined();
  });
});
