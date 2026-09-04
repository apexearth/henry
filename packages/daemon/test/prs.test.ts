// Pure parts of the PR reader: which remotes it claims, and that a non-GitHub remote never
// reaches `gh`. Anything that would actually spawn gh (and hit the network) is left out.
import { describe, expect, test } from "bun:test";
import { githubSlug, list } from "../src/prs";

describe("githubSlug", () => {
  test("github.com web URLs, as remoteWebUrl produces them", () => {
    expect(githubSlug("https://github.com/apexearth/henry")).toBe("apexearth/henry");
    expect(githubSlug("https://github.com/apexearth/henry.git")).toBe("apexearth/henry");
    expect(githubSlug("https://github.com/apexearth/henry/")).toBe("apexearth/henry");
  });

  test("anything else is not GitHub", () => {
    expect(githubSlug(undefined)).toBeUndefined();
    expect(githubSlug("https://gitlab.com/a/b")).toBeUndefined();
    expect(githubSlug("https://github.example.com/a/b")).toBeUndefined();
    expect(githubSlug("https://github.com/apexearth")).toBeUndefined();
    expect(githubSlug("https://github.com/a/b/pull/1")).toBeUndefined();
  });
});

test("a repo with no GitHub remote answers without running gh", async () => {
  const r = await list("/tmp/not-a-github-repo", "https://gitlab.com/a/b");
  expect(r.prs).toEqual([]);
  expect(r.slug).toBeUndefined();
  expect(r.note).toContain("github.com");
});
