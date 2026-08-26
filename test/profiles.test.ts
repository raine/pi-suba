import { describe, expect, it } from "vitest"
import { parseProfile, TOOL_POLICIES } from "../src/shared/profiles.ts"

describe("profiles", () => {
  it("parses frontmatter and body", () => {
    const profile = parseProfile(
      `---\nname: explore\ntools: read,bash\nload-context: false\nload-skills: false\nsystem-prompt: replace\nauto-complete: false\nthinking: low\n---\n\nExplore.\n`,
      "file",
    )
    expect(profile).toMatchObject({
      name: "explore",
      tools: "read-only",
      loadContext: false,
      loadSkills: false,
      systemPrompt: "replace",
      autoComplete: false,
      thinking: "low",
      body: "Explore.\n",
    })
    expect(TOOL_POLICIES[profile.tools]).toEqual(["read", "bash"])
  })
  it("uses filename fallback", () => expect(parseProfile("Prompt", "review").name).toBe("review"))
  it("rejects arbitrary tools and keys", () => {
    expect(() => parseProfile("---\ntools: read,write\n---\n", "x")).toThrow(
      "unsupported tools policy",
    )
    expect(() => parseProfile("---\nunknown: yes\n---\n", "x")).toThrow("unsupported profile key")
  })
})
