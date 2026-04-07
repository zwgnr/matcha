import { describe, expect, it } from "vitest";
import { buildLegacyClientSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        confirmWorkspaceArchive: true,
        confirmWorkspaceDelete: false,
      }),
    ).toEqual({
      confirmWorkspaceArchive: true,
      confirmWorkspaceDelete: false,
    });
  });
});
