import { describe, it, expect } from "@jest/globals";
import {
  ClaimsPreviewStore,
  PREVIEW_TTL_MS,
} from "../../src/web/claims-preview-store.js";

const preview = {
  claims: [{ channelId: "1", action: "read-only" as const }],
  approvedAt: "2026-10-07T10:00:00.000Z",
};

describe("ClaimsPreviewStore", () => {
  it("returns what was stored for the same session and server", () => {
    const store = new ClaimsPreviewStore();
    const token = store.put("s1", "g1", preview);
    expect(store.get(token, "s1", "g1")).toEqual(preview);
  });

  it("is bound to the session and server that previewed", () => {
    const store = new ClaimsPreviewStore();
    const token = store.put("s1", "g1", preview);
    expect(store.get(token, "s2", "g1")).toBeNull();
    expect(store.get(token, "s1", "g2")).toBeNull();
    expect(store.get("guess", "s1", "g1")).toBeNull();
  });

  it("expires", () => {
    let now = 1_000;
    const store = new ClaimsPreviewStore(() => now);
    const token = store.put("s1", "g1", preview);
    now += PREVIEW_TTL_MS + 1;
    expect(store.get(token, "s1", "g1")).toBeNull();
  });

  it("forgets a deleted token and stays bounded", () => {
    const store = new ClaimsPreviewStore();
    const token = store.put("s1", "g1", preview);
    store.delete(token);
    expect(store.get(token, "s1", "g1")).toBeNull();
    const first = store.put("s1", "g1", preview);
    for (let i = 0; i < 300; i += 1) store.put("s1", "g1", preview);
    expect(store.get(first, "s1", "g1")).toBeNull();
  });

  it("issues distinct, unguessable tokens", () => {
    const store = new ClaimsPreviewStore();
    const a = store.put("s1", "g1", preview);
    const b = store.put("s1", "g1", preview);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(30);
  });
});
