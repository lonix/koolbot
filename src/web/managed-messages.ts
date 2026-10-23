/**
 * Where an admin re-posts each message KoolBot manages (#1428): the owning
 * feature's page, at the card that holds the Re-post button. All settings shows
 * the id read-only and links here instead of offering a second path.
 */

export const MANAGED_REPOST_LINKS: Readonly<Record<string, string>> = {
  "quotes.header_message_id": "/admin/quotes#repost-header",
  "notices.header_message_id": "/admin/notices#repost-header",
  "rules.message_id": "/admin/rules#repost-message",
};

/** The Re-post page for a managed setting key, or undefined when it has none. */
export function repostHrefFor(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(MANAGED_REPOST_LINKS, key)
    ? MANAGED_REPOST_LINKS[key]
    : undefined;
}
