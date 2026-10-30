// `#157` lookups (github.ts): how GitHub's answers become cards, and that the projects Henry
// finds for a repo are written once and then left to the user. Nothing here spawns gh.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./sessiond-helper";

const home = mkdtempSync(join(tmpdir(), "henry-github-"));
process.env.HENRY_HOME = home;
const { config, configPath, noteGithubRepo } = await import("../src/config");
const github = await import("../src/github");
const db = await import("../src/db");

afterAll(() => rmScratch(home));

describe("project items", () => {
  const node = (content: object, fields: object[] = []) => ({ content, fieldValues: { nodes: fields } });
  const base = { number: 3, title: "Cut call-home time", url: "u", body: "b", repository: { nameWithOwner: "o/sentinel" } };

  test("an issue carries the project's set fields, Title left out", () => {
    const it = github.fromProjectNode(
      node({ __typename: "Issue", state: "OPEN", ...base, labels: { nodes: [{ name: "fw" }] }, assignees: { nodes: [{ login: "ann" }] } }, [
        { text: "Cut call-home time", field: { name: "Title" } },
        { name: "Next", field: { name: "Status" } },
        { number: 3, field: { name: "Points" } },
        {},
      ]),
      "Transit Fortress",
    )!;
    expect(it).toMatchObject({ repo: "o/sentinel", number: 3, kind: "issue", state: "open", project: "Transit Fortress", labels: ["fw"], assignees: ["ann"] });
    expect(it.fields).toEqual([
      { name: "Status", value: "Next" },
      { name: "Points", value: "3" },
    ]);
  });

  test("pull request states", () => {
    const pr = (state: string, isDraft = false) => github.fromProjectNode(node({ __typename: "PullRequest", state, isDraft, ...base }), "p")!.state;
    expect(pr("OPEN", true)).toBe("draft");
    expect(pr("MERGED")).toBe("merged");
    expect(pr("CLOSED")).toBe("closed");
  });

  test("a draft item (no number, no repo) is not a card", () => {
    expect(github.fromProjectNode(node({ title: "an idea" }), "p")).toBeUndefined();
    expect(github.fromProjectNode({ content: null }, "p")).toBeUndefined();
  });

  test("a long body is clipped", () => {
    const it = github.fromProjectNode(node({ __typename: "Issue", state: "OPEN", ...base, body: "x".repeat(2000) }), "p")!;
    expect(it.body.length).toBeLessThan(500);
    expect(it.body.endsWith("…")).toBe(true);
  });
});

test("the REST issue endpoint answers for PRs too", () => {
  expect(github.fromRestIssue("o/r", { number: 9, state: "open", pull_request: {}, draft: true }).state).toBe("draft");
  expect(github.fromRestIssue("o/r", { number: 9, state: "closed", pull_request: { merged_at: "2026-10-01" } })).toMatchObject({ kind: "pr", state: "merged" });
  expect(github.fromRestIssue("o/r", { number: 9, state: "closed", labels: ["bug", { name: "p1" }] })).toMatchObject({ kind: "issue", state: "closed", labels: ["bug", "p1"] });
});

describe("config.github.repos", () => {
  test("a discovered repo is written once; an existing entry is the user's", () => {
    writeFileSync(configPath, JSON.stringify({ retentionDays: 7 }));
    noteGithubRepo("o/citadel", ["o/1"]);
    expect(config.github.repos["o/citadel"]).toEqual({ projects: ["o/1"] });
    noteGithubRepo("o/citadel", ["o/2"]);
    expect(config.github.repos["o/citadel"]).toEqual({ projects: ["o/1"] });
    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.retentionDays).toBe(7);
    expect(onDisk.github.repos).toEqual({ "o/citadel": { projects: ["o/1"] } });
    expect(config.github.pickModel).toBe("claude-haiku-5-5");
  });
});

test("a session in no GitHub repo answers without asking GitHub", async () => {
  db.insertSession({ id: "s1", cwd: home, title: "t", createdAt: Date.now(), status: "running" });
  const r = await github.resolveRef("s1", 157, "start #157 next", false);
  expect(r.items).toEqual([]);
  expect(r.note).toContain("not in a GitHub repo");
});
