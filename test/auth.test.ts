import { describe, expect, it } from "vitest";
import {
  parseTokenFromHeaders,
  parseTokenFromUrl,
  isTokenValid,
  requestNeedsToken,
} from "../src/server/auth.js";

// Note: isTokenValid and requestNeedsToken depend on AUTH_ENABLED which is read from
// process.env at module load time. In tests, AGMUX_TOKEN_ENABLED is unset so AUTH_ENABLED=false,
// meaning these functions return permissive defaults. We test the pure parsing functions
// independently, and verify the permissive behavior when auth is disabled.

describe("parseTokenFromHeaders", () => {
  it("extracts x-agmux-token header", () => {
    expect(parseTokenFromHeaders({ "x-agmux-token": "abc123" })).toBe("abc123");
  });

  it("extracts first non-empty value from array x-agmux-token", () => {
    expect(parseTokenFromHeaders({ "x-agmux-token": ["", "tok"] })).toBe("tok");
  });

  it("extracts Bearer token from Authorization header", () => {
    expect(parseTokenFromHeaders({ authorization: "Bearer mytoken" })).toBe("mytoken");
  });

  it("is case-insensitive for Bearer prefix", () => {
    expect(parseTokenFromHeaders({ authorization: "bearer MYTOKEN" })).toBe("MYTOKEN");
  });

  it("returns null for non-Bearer Authorization", () => {
    expect(parseTokenFromHeaders({ authorization: "Basic xyz" })).toBeNull();
  });

  it("extracts Bearer token from array Authorization", () => {
    expect(parseTokenFromHeaders({ authorization: ["Basic xyz", "Bearer good"] })).toBe("good");
  });

  it("returns null when no auth headers present", () => {
    expect(parseTokenFromHeaders({})).toBeNull();
  });

  it("returns null for empty x-agmux-token", () => {
    expect(parseTokenFromHeaders({ "x-agmux-token": "" })).toBeNull();
  });

  it("prefers x-agmux-token over Authorization", () => {
    expect(
      parseTokenFromHeaders({ "x-agmux-token": "direct", authorization: "Bearer other" }),
    ).toBe("direct");
  });
});

describe("parseTokenFromUrl", () => {
  it("extracts ?token= query param", () => {
    expect(parseTokenFromUrl("/api/ptys?token=abc123")).toBe("abc123");
  });

  it("returns null when no token param", () => {
    expect(parseTokenFromUrl("/api/ptys")).toBeNull();
  });

  it("returns null for empty token param", () => {
    expect(parseTokenFromUrl("/api/ptys?token=")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseTokenFromUrl(undefined)).toBeNull();
  });

  it("handles token among multiple params", () => {
    expect(parseTokenFromUrl("/api/ptys?foo=bar&token=xyz&baz=1")).toBe("xyz");
  });
});

describe("isTokenValid (auth disabled in test env)", () => {
  it("returns true regardless of tokens when auth is disabled", () => {
    expect(isTokenValid(null, null)).toBe(true);
    expect(isTokenValid("wrong", null)).toBe(true);
    expect(isTokenValid(null, "wrong")).toBe(true);
  });
});

describe("requestNeedsToken (auth disabled in test env)", () => {
  it("returns false for all routes when auth is disabled", () => {
    expect(requestNeedsToken("GET", "/api/ptys")).toBe(false);
    expect(requestNeedsToken("POST", "/api/ptys/launch")).toBe(false);
    expect(requestNeedsToken("OPTIONS", "/api/ptys")).toBe(false);
  });
});
