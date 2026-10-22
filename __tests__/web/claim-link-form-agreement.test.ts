import { describe, it, expect } from "@jest/globals";
import { renderChannelClaimsPage } from "../../src/web/channel-claims-view.js";
import { renderAdoptPage } from "../../src/web/adopt-view.js";
import { claimKeyFor } from "../../src/services/channel-claims.js";
import { claimsFromForm } from "../../src/services/channel-claims-form.js";
import { channelsScan, scanChannel } from "./channels-scan-fixtures.js";

/**
 * The Server scan offers Claim on a row only if Channel claims can show that
 * channel with that feature chosen (#1364): the scan's rule and the form must
 * agree for every kind of row, or a link lands on a page that drops the choice.
 */

const base = {
  csrfToken: "t",
  remainingMs: 1000,
  navFeatureStatus: {} as never,
  groups: [],
  claims: [],
  plan: null,
  problems: [],
  previewToken: null,
};

function scanWithGuesses(): ReturnType<typeof channelsScan> {
  const scan = channelsScan();
  // Every kind of row that can be claimed: uncategorised, categorised, an
  // orphan (its category is not in the scan) and a category.
  scan.channels.push(
    scanChannel({
      id: "41",
      name: "birthday-wishes",
      parentId: "gone",
      featureGuess: "birthdays",
      position: 10,
    }),
    scanChannel({
      id: "42",
      name: "birthdays",
      parentId: "20",
      parentName: "Community",
      featureGuess: "birthdays",
      position: 11,
    }),
  );
  return scan;
}

describe("Claim link and Channel claims form agree (#1364)", () => {
  const scan = scanWithGuesses();
  const claimable = scan.channels.flatMap((c) => {
    const key = claimKeyFor(c);
    return key ? [{ c, key }] : [];
  });

  it("covers uncategorised, categorised, orphan and category rows", () => {
    const parents = claimable.map(({ c }) => c.parentId);
    expect(parents).toContain(null);
    expect(parents).toContain("20");
    expect(parents).toContain("gone");
    expect(claimable.map(({ c }) => c.kind)).toContain("category");
  });

  for (const { c, key } of claimable) {
    it(`shows ${c.name} (${c.kind}, parent ${c.parentId ?? "none"}) with ${key} chosen`, () => {
      const html = renderChannelClaimsPage({
        ...base,
        scan: scan as never,
        claims: [{ channelId: c.id, action: "leave", bindKey: key }],
        prefill: { channelId: c.id, channelName: c.name, featureLabel: key },
      });
      expect(html).toContain(`<tr id="claim-${c.id}">`);
      expect(html).toContain(
        `name="bind_${c.id}"><option value="">(none)</option>`,
      );
      const select = html.slice(html.indexOf(`name="bind_${c.id}">`));
      expect(select.slice(0, select.indexOf("</select>"))).toContain(
        `<option value="${key}" selected>`,
      );
    });

    it(`keeps ${c.name}'s binding when Preview is submitted`, () => {
      const parsed = claimsFromForm(
        { [`action_${c.id}`]: "leave", [`bind_${c.id}`]: key },
        scan.channels.map((x) => ({
          id: x.id,
          kind: x.kind === "category" ? "category" : "other",
          parentId: x.parentId,
        })),
      );
      expect(parsed.claims).toEqual([
        expect.objectContaining({ channelId: c.id, bindKey: key }),
      ]);
    });
  }

  it("offers Claim in the Channels tab on exactly these rows", () => {
    const html = renderAdoptPage({
      csrfToken: "t",
      remainingMs: 1000,
      navFeatureStatus: {} as never,
      sampled: false,
      tab: "channels",
      filter: "claimable",
      scan,
    });
    const links = [...html.matchAll(/claims\?channel=(\d+)&amp;/g)].map(
      (m) => m[1],
    );
    expect(links.sort()).toEqual(claimable.map(({ c }) => c.id).sort());
  });
});
