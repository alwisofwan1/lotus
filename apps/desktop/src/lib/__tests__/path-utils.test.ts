import { describe, expect, it } from "vitest";
import { joinUnder, pathUnder, separatorOf, trimTrailingSeparators } from "@/lib/path-utils";

describe("separatorOf", () => {
  it("follows the root: backslash only when the root has one", () => {
    expect(separatorOf("C:\\proj")).toBe("\\");
    expect(separatorOf("\\\\wsl.localhost\\Ubuntu\\home")).toBe("\\");
    expect(separatorOf("C:/proj")).toBe("/");
    expect(separatorOf("//wsl.localhost/Ubuntu/home")).toBe("/");
    expect(separatorOf("/home/dev")).toBe("/");
  });
});

describe("trimTrailingSeparators", () => {
  it("drops trailing separators of either kind", () => {
    expect(trimTrailingSeparators("C:\\proj\\")).toBe("C:\\proj");
    expect(trimTrailingSeparators("/home/dev//")).toBe("/home/dev");
    expect(trimTrailingSeparators("/")).toBe("");
  });
});

describe("joinUnder", () => {
  it("joins with the root's separator and never doubles it", () => {
    expect(joinUnder("C:\\proj\\", "src/a.ts")).toBe("C:\\proj\\src\\a.ts");
    expect(joinUnder("//wsl.localhost/Ubuntu/dev/", "src/a.ts")).toBe("//wsl.localhost/Ubuntu/dev/src/a.ts");
    expect(joinUnder("/", "etc")).toBe("/etc");
  });
});

describe("pathUnder", () => {
  it("returns what lies below the base, with either separator at the boundary", () => {
    expect(pathUnder("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src\\a.ts");
    expect(pathUnder("//wsl.localhost/U/dev/", "//wsl.localhost/U/dev/a.ts")).toBe("a.ts");
    expect(pathUnder("//wsl.localhost/U/dev", "//wsl.localhost/U/dev\\a.ts")).toBe("a.ts");
    expect(pathUnder("/", "/etc")).toBe("etc");
  });

  it("is null for the base itself, a sibling sharing its prefix, or anything outside", () => {
    expect(pathUnder("C:\\proj", "C:\\proj")).toBeNull();
    expect(pathUnder("C:\\proj", "C:\\proj\\")).toBeNull();
    expect(pathUnder("C:\\proj", "C:\\proj-old\\a.ts")).toBeNull();
    expect(pathUnder("/home/dev", "/srv/a.ts")).toBeNull();
  });
});
