import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectAgentOutputSignal,
  mergeAgentOutputTail,
  type AgentFamily,
  type AgentOutputSignal,
} from "../src/readiness/markers.js";

type ReplayFixture = {
  id: string;
  family: AgentFamily | null;
  expected: AgentOutputSignal;
  transcript: string;
};

function loadFixtures(): ReplayFixture[] {
  const url = new URL("./fixtures/readiness/parity-fixtures.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(url, "utf8")) as ReplayFixture[];
  return parsed;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomChunks(input: string, seed: number, maxChunk = 48): string[] {
  const rand = seededRandom(seed);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const remaining = input.length - cursor;
    const size = Math.max(1, Math.min(remaining, Math.floor(rand() * maxChunk) + 1));
    chunks.push(input.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

function replaySignal(chunks: string[], family: AgentFamily | null): AgentOutputSignal {
  let tail = "";
  let last: AgentOutputSignal = "none";
  for (const chunk of chunks) {
    tail = mergeAgentOutputTail(tail, chunk);
    last = detectAgentOutputSignal(tail, family);
  }
  return last;
}

describe("readiness replay parity", () => {
  const fixtures = loadFixtures();

  for (const fixture of fixtures) {
    it(`matches fixture ${fixture.id} with direct transcript`, () => {
      expect(replaySignal([fixture.transcript], fixture.family)).toBe(fixture.expected);
    });

    it(`matches fixture ${fixture.id} across randomized chunk boundaries`, () => {
      for (let seed = 1; seed <= 50; seed += 1) {
        const chunks = randomChunks(fixture.transcript, seed);
        expect(replaySignal(chunks, fixture.family)).toBe(fixture.expected);
      }
    });
  }
});
