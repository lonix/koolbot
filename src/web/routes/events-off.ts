import type { NextFunction, Request, Response } from "express";
import { ConfigService } from "../../services/config-service.js";
import { renderErrorPage } from "../views.js";

/**
 * The /me pages that exist only while Events is on (New event, Event
 * presets): a 404 that says why while `events.enabled` is off. A strict read,
 * so a failed read is a 500 and never reads as "Events are off".
 */
function eventsOffNotFound(res: Response): void {
  res
    .status(404)
    .type("text/html")
    .send(
      renderErrorPage({
        title: "Not found",
        heading: "Not found",
        bodyHtml:
          '<p>Events are switched off on this server. Visit <a href="/me/">/me</a> for your own preferences.</p>',
        product: "KoolBot",
      }),
    );
}

export function requireEventsOn(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  void ConfigService.getInstance()
    .getBooleanStrict("events.enabled", false)
    .then((on) => {
      if (on) next();
      else eventsOffNotFound(res);
    })
    .catch(next);
}
