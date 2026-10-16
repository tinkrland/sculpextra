import type { ContentLink, QueueId, ResponseLibraryEntry, Ticket } from "./types";
import { DEFAULT_CONFIG } from "./config";
import type { CoreConfig } from "./config";
import type { SupportService } from "./support";
import { deepFreeze } from "./events";

// the response library. canned answers must reference doc/kb/academy
// content by link; no free-text knowledge lives only in canned
// responses (spec: workspace). entries validate on save and again
// on use, so config drift (a retired content host) can never send a
// response whose links point nowhere. free-text responses remain
// allowed alongside the library; the agent owns what gets sent.

export class ResponseLibraryError extends Error {}

export class ResponseLibrary {
  private readonly entries = new Map<string, ResponseLibraryEntry>();

  constructor(private readonly config: CoreConfig = DEFAULT_CONFIG) {}

  // validate on save: body required, at least one content link, and
  // every link must be an https url on a configured content host
  // tagged doc/kb/academy.
  public save(entry: ResponseLibraryEntry): ResponseLibraryEntry {
    const id = entry.id;
    if (!id) throw new ResponseLibraryError("entry id required");
    if (!entry.body.trim()) {
      throw new ResponseLibraryError(`entry ${id}: body required`);
    }
    if (entry.links.length === 0) {
      throw new ResponseLibraryError(
        `entry ${id}: canned answers must reference doc/kb/academy content by link`,
      );
    }
    for (const link of entry.links) {
      this.assertValidLink(id, link);
    }
    const frozen = deepFreeze(structuredClone(entry));
    this.entries.set(id, frozen);
    return frozen;
  }

  public get(id: string): ResponseLibraryEntry | undefined {
    return this.entries.get(id);
  }

  // entries usable for a given ticket: same queue, and any market
  // or language scope on the entry must match the case.
  public listForTicket(
    support: SupportService,
    ticketId: string,
  ): readonly ResponseLibraryEntry[] {
    const t = support.getTicket(ticketId);
    if (!t) throw new ResponseLibraryError(`unknown ticket: ${ticketId}`);
    const c = support.getCase(t.case_ref);
    if (!c) throw new ResponseLibraryError(`case ${t.case_ref} missing for ticket ${t.id}`);
    const out: ResponseLibraryEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.queue !== t.queue) continue;
      if (e.market !== undefined && e.market !== c.market) continue;
      if (e.language !== undefined && e.language !== c.language) continue;
      out.push(e);
    }
    return Object.freeze(out);
  }

  private assertValidLink(entryId: string, link: ContentLink): void {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      throw new ResponseLibraryError(`entry ${entryId}: link "${link.url}" is not a valid url`);
    }
    if (url.protocol !== "https:") {
      throw new ResponseLibraryError(`entry ${entryId}: link "${link.url}" must be https`);
    }
    if (!this.config.content_link_hosts.includes(url.host)) {
      throw new ResponseLibraryError(
        `entry ${entryId}: link "${link.url}" is not on a doc/kb/academy content host`,
      );
    }
  }
}

// send a library response. re-validates the entry's links against
// the current config, then responds with the entry reference and
// its links in the response_sent payload, so audit shows exactly
// which canned answer went out. state moves to waiting_on_user by
// the usual respond flow.
export function respondFromLibrary(
  support: SupportService,
  library: ResponseLibrary,
  ticketId: string,
  agentId: string,
  entryId: string,
  now: string,
): Ticket {
  const entry = library.get(entryId);
  if (!entry) throw new ResponseLibraryError(`unknown library entry: ${entryId}`);
  const t = support.getTicket(ticketId);
  if (!t) throw new ResponseLibraryError(`unknown ticket: ${ticketId}`);
  const usable = library
    .listForTicket(support, ticketId)
    .some((e) => e.id === entryId);
  if (!usable) {
    throw new ResponseLibraryError(
      `entry ${entryId} is not usable for ticket ${ticketId} (queue/market/language scope)`,
    );
  }
  const c = support.getCase(t.case_ref);
  if (entry.market !== undefined && entry.market !== c?.market) {
    throw new ResponseLibraryError(`entry ${entryId} does not match the ticket market`);
  }
  if (entry.language !== undefined && entry.language !== c?.language) {
    throw new ResponseLibraryError(`entry ${entryId} does not match the ticket language`);
  }
  return support.respond(ticketId, agentId, entry.body, now, {
    entry_id: entry.id,
    links: entry.links,
  });
}
