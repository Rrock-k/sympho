import { describe, it, expect } from "vitest";
import { parseConfig, normalizeState, maxConcurrentForState } from "../src/config.js";

describe("parseConfig", () => {
  it("applies defaults for empty config", () => {
    const config = parseConfig({});

    expect(config.tracker.kind).toBe("linear");
    expect(config.tracker.active_states).toEqual(["Todo", "In Progress"]);
    expect(config.polling.interval_ms).toBe(30_000);
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.agent.max_turns).toBe(20);
    expect(config.hooks.timeout_ms).toBe(60_000);
  });

  it("parses custom config", () => {
    const config = parseConfig({
      tracker: { kind: "memory", active_states: ["Open"] },
      polling: { interval_ms: 5000 },
      agent: { max_concurrent_agents: 3, max_turns: 5 },
    });

    expect(config.tracker.kind).toBe("memory");
    expect(config.tracker.active_states).toEqual(["Open"]);
    expect(config.polling.interval_ms).toBe(5000);
    expect(config.agent.max_concurrent_agents).toBe(3);
    expect(config.agent.max_turns).toBe(5);
  });

  it("coerces string integers", () => {
    const config = parseConfig({
      polling: { interval_ms: "10000" },
      agent: { max_concurrent_agents: "5" },
    });

    expect(config.polling.interval_ms).toBe(10_000);
    expect(config.agent.max_concurrent_agents).toBe(5);
  });

  it("normalizes max_concurrent_agents_by_state keys", () => {
    const config = parseConfig({
      agent: {
        max_concurrent_agents_by_state: {
          "In Progress": 3,
          "TODO": 1,
        },
      },
    });

    expect(config.agent.max_concurrent_agents_by_state).toEqual({
      "in progress": 3,
      "todo": 1,
    });
  });
});

describe("normalizeState", () => {
  it("lowercases and trims", () => {
    expect(normalizeState("  In Progress ")).toBe("in progress");
    expect(normalizeState("TODO")).toBe("todo");
  });
});

describe("maxConcurrentForState", () => {
  it("returns per-state limit when configured", () => {
    const config = parseConfig({
      agent: {
        max_concurrent_agents: 10,
        max_concurrent_agents_by_state: { "in progress": 3 },
      },
    });

    expect(maxConcurrentForState(config, "In Progress")).toBe(3);
  });

  it("falls back to global limit", () => {
    const config = parseConfig({ agent: { max_concurrent_agents: 7 } });
    expect(maxConcurrentForState(config, "Todo")).toBe(7);
  });
});
