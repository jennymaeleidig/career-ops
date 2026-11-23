// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Tech Jobs for Good provider — techjobsforgood.com, a server-rendered Django
// board for mission-driven / nonprofit / social-impact tech roles (US-heavy,
// mostly remote). Employers pay to post directly, and every posting carries the
// employer's own ATS apply URL. It is a MULTI-EMPLOYER board, so an entry
// belongs under `job_boards:` in portals.yml, not `tracked_companies:`.
//
// Wire in with either an explicit `provider: techjobsforgood`, or just a
// `careers_url` on this host (a URL-pattern detect() claims it):
//
//   job_boards:
//     - name: Tech Jobs for Good
//       provider: techjobsforgood
//       careers_url: https://techjobsforgood.com/jobs/
//       enabled: true
//
// WHAT THE PROVIDER READS, AND WHY IT IS THE FREE INDEX.
// The anonymous index (`/jobs/?page=N`) lists the COMPLETE live inventory:
// measured 2026-10-27 across all 830 ids in the public sitemap, 101 were live
// and exactly those 101 were in the free index — zero live postings missing,
// zero dead ids present. The "Upgrade to see 724 additional jobs" banner counts
// EXPIRED archive rows, not hidden live ones (729 of 830 sitemap ids had no
// JobPosting block). So reading the index is complete, and the sitemap walk
// (830 requests, ~88% dead) buys nothing. Measured cost of this path: 4 index
// requests + one per posting (101) = 105 requests, ~8 s.
//
// The index paginates `?page=N` 30 at a time; page 5 returns 404. A filtered
// URL (`?locations=remote` → 38, `?q=engineer` → 27) is a strict SUBSET that
// never reveals an id outside the 101, so this provider always fetches the
// unfiltered index and never inherits a URL filter.
//
// WHY TWO REQUESTS PER POSTING (INDEX + CARD) ARE UNAVOIDABLE.
// An index card carries id, title, employer, location and salary only — no
// posted date and no apply URL. The per-posting page `/jobs/{id}/` carries a
// schema.org JobPosting JSON-LD block (title, hiringOrganization, datePosted,
// description, baseSalary, location) plus the employer's canonical apply URL
// inline in a `window.open('<ats url>')` call. There is no API, RSS feed or SSR
// state blob (`/jobs.json` and `/jobs.rss` 404; `?format=json` still returns
// HTML).
//
// LIVENESS IS THE JSON-LD BLOCK, NEVER THE STATUS CODE. An expired posting
// answers HTTP 200 with an empty ~29 KB shell and no JobPosting block; live
// pages are 44-154 KB. A card with no block is skipped and counted — never
// emitted with a fabricated or empty required field, and never read as closed
// from a status code.
//
// `Job.url` IS THE EMPLOYER'S ATS APPLY URL, not the board card. Rule 2's
// "shortest verifiable path to the employer", and here it is also safe as the
// dedup key: verified live that all 101 live postings carry an apply URL and
// all 101 are distinct (1:1 with postings, unlike cfengage's shared careers
// pages). The board's own card URL is kept as attribution in `description`,
// and is the fallback when a card carries no usable apply URL — measured live,
// exactly two of 101: one where the only apply channel is a `mailto:`, one where
// the employer link is plain `http:` (refused rather than downgraded). Both
// card URLs stay unique per posting, so the fallback is still a valid key.
// The board's own referral tag (`?gh_src=TechJobsForGood`,
// `?source=TechJobsForGood`) is stripped so the key matches the plain employer
// URL.
//
// robots.txt is `User-agent: *` / `Allow: /` with no AI-crawler group and no
// Disallow — measured 2026-10-27. No status signal, no auth, no candidate
// paywall over live inventory.
//
// WHAT THIS PARSER CANNOT RECOVER (left off rather than guessed):
//   - salary when `baseSalary.value.unitText` is not YEAR (measured: 3 of 101
//     postings are hourly) — an hourly rate is not annualized from an assumed
//     hours count.
//   - `location` beyond the JSON-LD's own coarse shape: many postings are
//     TELECOMMUTE with a country-only `applicantLocationRequirements`, so the
//     index card's location string is preferred when the JSON-LD has no
//     `jobLocation` addresses.
//   - `requisitionId`: the source exposes no employer requisition id.

import { fetchTextWithRetry, sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { decodeEntities } from './_html-entities.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const ORIGIN = 'https://techjobsforgood.com';
const INDEX_URL = `${ORIGIN}/jobs/`;
const CARD_PATH = '/jobs';

/** The board's own page size (live: 30/30/30/11 across 4 pages). */
const PAGE_SIZE = 30;

// The free index has never exceeded 4 pages. 20 is generous headroom for a
// growth spurt before the cap warns; the hard ceiling is independent of it.
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 100;

/** Pacing between index pages (live probe used 120 ms; no throttling observed). */
const INTER_PAGE_DELAY_MS = 120;

/**
 * Card fetches run in small parallel batches. 8 in flight with 120 ms between
 * batches measured 101 cards in ~6 s with no rate-limiting or Cloudflare
 * challenge, so this is citizenship rather than a measured throttle.
 */
const CARD_CONCURRENCY = 8;
const INTER_CARD_BATCH_DELAY_MS = 120;

/** Hosts that identify the board itself, for the URL-pattern detect(). */
const BOARD_HOSTS = new Set(['techjobsforgood.com', 'www.techjobsforgood.com']);

/** A card's title/company/location host, used when the JSON-LD is coarse. */
const CARD_MARKER_RE = /<div class="[^"]*\bjob-card\b[^"]*"/g;
const CARD_ID_RE = /href="\/jobs\/(\d+)\//;
const CARD_TITLE_RE = /<div class="[^"]*job-title[^"]*"[^>]*?\btitle="([^"]*)"/;
const CARD_COMPANY_RE = /<div class="[^"]*company-name[^"]*"[^>]*?\btitle="([^"]*)"/;
const CARD_LOCATION_RE = /<span class="location"[^>]*?\btitle="([^"]*)"/;
const STATED_COUNT_RE = /(\d+)\s+jobs found/i;

const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;
const APPLY_URL_RE = /window\.open\(\s*'([^']*)'/i;

/** Resolve the index-page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A NaN-safe date parse: absent/empty stays undefined rather than becoming
 * `NaN`, and a valid epoch 0 is not swallowed by a falsy check.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function toEpochMs(value) {
  if (!value) return undefined;
  const raw = typeof value === 'string' ? value.trim() : value;
  if (!raw) return undefined;
  const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {unknown} value */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * The board's own host, anchored so `techjobsforgood.com.evil.example` is not
 * claimed.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isBoardHost(hostname) {
  return BOARD_HOSTS.has(String(hostname ?? '').toLowerCase().replace(/\.$/, ''));
}

/**
 * Parse one index page.
 *
 * Cards are split on the `job-card` container marker and each block is read
 * positionally only for the fields the card's own markup labels (`job-title`,
 * `company-name`, `location`), so a template reshuffle inside a block does not
 * matter. `rawCardCount` is the number of card containers the SOURCE rendered —
 * the walk's short-page stop reads that, never a post-dedup count, so one bad
 * card cannot end the walk early.
 *
 * @param {unknown} html
 * @returns {{ cards: {id: string, title: string, company: string, location: string, url: string}[], rawCardCount: number, statedCount: number, sawCardMarkup: boolean }}
 */
export function parseIndexPage(html) {
  const source = typeof html === 'string' ? html : '';

  const starts = [];
  CARD_MARKER_RE.lastIndex = 0;
  let marker;
  while ((marker = CARD_MARKER_RE.exec(source)) !== null) starts.push(marker.index);

  /** @type {{id: string, title: string, company: string, location: string, url: string}[]} */
  const cards = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const block = source.slice(starts[i], starts[i + 1] ?? source.length);
    const idMatch = CARD_ID_RE.exec(block);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (!id || seen.has(id)) continue;
    const segment = safeEncodeURIComponent(id);
    if (segment === null) continue;
    seen.add(id);
    cards.push({
      id,
      title: decodeEntities(CARD_TITLE_RE.exec(block)?.[1] ?? '').trim(),
      company: decodeEntities(CARD_COMPANY_RE.exec(block)?.[1] ?? '').trim(),
      location: decodeEntities(CARD_LOCATION_RE.exec(block)?.[1] ?? '').trim(),
      url: `${ORIGIN}${CARD_PATH}/${segment}/`,
    });
  }

  const statedMatch = STATED_COUNT_RE.exec(source);
  return {
    cards,
    rawCardCount: starts.length,
    statedCount: statedMatch ? Number(statedMatch[1]) : 0,
    sawCardMarkup: starts.length > 0,
  };
}

/**
 * Parse one per-posting card. The presence of a `JobPosting` JSON-LD block is
 * the source's liveness signal (an expired page is a 200 shell with none).
 *
 * @param {unknown} html
 * @returns {{ posting: Record<string, any> | null, applyUrl: string }}
 */
export function parseJobCard(html) {
  const source = typeof html === 'string' ? html : '';

  let posting = null;
  const block = JSONLD_RE.exec(source);
  if (block) {
    try {
      const parsed = JSON.parse(block[1]);
      if (parsed && typeof parsed === 'object' && parsed['@type'] === 'JobPosting') {
        posting = parsed;
      }
    } catch {
      posting = null;
    }
  }

  const apply = APPLY_URL_RE.exec(source);
  return { posting, applyUrl: decodeEntities(apply?.[1] ?? '').trim() };
}

/**
 * A host-controlled apply link, accepted only as an absolute `https:` URL: a
 * plain-`http:` link would downgrade the user's session on the way to applying.
 * The board's own referral tag is stripped so the URL is the employer's plain
 * one (a value naming the board is a referral tag, not posting identity).
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function employerApplyUrl(raw) {
  const value = text(raw);
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  for (const key of [...parsed.searchParams.keys()]) {
    if (/techjobsforgood|^tjfg$/i.test(parsed.searchParams.get(key) ?? '')) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.href;
}

/**
 * Location from the JSON-LD `jobLocation` addresses, prefixed when the posting
 * is remote. Country-only addresses collapse (`US; US` → `US`). When the
 * payload has no address at all the index card's own location string is used —
 * it is often richer (`Remote (US, CAN)`) than the coarse country requirement.
 *
 * @param {Record<string, any>} posting
 * @param {string} fallback
 * @returns {string}
 */
function locationFrom(posting, fallback) {
  const remote = String(posting?.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE';
  const places = Array.isArray(posting?.jobLocation)
    ? posting.jobLocation
    : posting?.jobLocation
      ? [posting.jobLocation]
      : [];

  /** @type {string[]} */
  const labels = [];
  for (const place of places) {
    const address = place && typeof place === 'object' ? place.address : null;
    if (!address || typeof address !== 'object') continue;
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map(text)
      .filter(Boolean);
    if (parts.length > 0) labels.push(parts.join(', '));
  }
  const unique = [...new Set(labels)];
  if (unique.length > 0) return remote ? `Remote — ${unique.join('; ')}` : unique.join('; ');
  return text(fallback) || (remote ? 'Remote' : '');
}

/**
 * Annualized salary from the JSON-LD `baseSalary`, when it is an ANNUAL figure.
 * An hourly/monthly rate is left off rather than annualized from an assumption.
 * Handles both value shapes the source emits live: `{minValue, maxValue}` and
 * a single `{Value}`.
 *
 * @param {Record<string, any>} posting
 * @returns {{min: number, max: number, currency?: string}|undefined}
 */
function salaryFrom(posting) {
  const raw = posting?.baseSalary;
  const amounts = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  for (const amount of amounts) {
    if (!amount || typeof amount !== 'object') continue;
    const value = amount.value && typeof amount.value === 'object' ? amount.value : amount;
    const unit = text(value.unitText).toUpperCase();
    if (unit && unit !== 'YEAR') continue;
    let min = toFiniteNumber(value.minValue);
    let max = toFiniteNumber(value.maxValue);
    const single = toFiniteNumber(value.Value) ?? toFiniteNumber(value.value);
    if (min === undefined && max === undefined && single !== undefined) {
      min = single;
      max = single;
    }
    if (min === undefined && max === undefined) continue;
    if (min === undefined) min = max;
    if (max === undefined) max = min;
    const currency = text(amount.currency).toUpperCase();
    return /** @type {{min: number, max: number, currency?: string}} */ ({
      min,
      max,
      ...(currency ? { currency } : {}),
    });
  }
  return undefined;
}

/**
 * Normalize one card + its index card into the scanner's Job shape. Exported
 * for unit tests.
 *
 * @param {{posting: Record<string, any> | null, applyUrl: string}} card
 * @param {{id: string, title: string, company: string, location: string, url: string}} indexCard
 * @returns {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number, max: number, currency?: string}, externalId?: string} | null}
 */
export function normalizeJob(card, indexCard) {
  const posting = card?.posting;
  if (!posting) return null;

  const title = text(posting.title) || text(indexCard?.title);
  const cardUrl = text(indexCard?.url);
  if (!title || !cardUrl) return null;

  // The employer's ATS URL is the canonical identity; the board card is the
  // fallback only when the card carries no usable https apply URL.
  const applyUrl = employerApplyUrl(card?.applyUrl);
  const url = applyUrl || cardUrl;

  const jd = htmlToText(posting.description);
  const description = [jd, `Source: ${cardUrl}`].filter(Boolean).join('\n\n');

  /** @type {{title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number, max: number, currency?: string}, externalId?: string}} */
  const job = {
    title,
    url,
    company: text(posting.hiringOrganization?.name) || text(indexCard?.company),
    location: locationFrom(posting, indexCard?.location ?? ''),
    externalId: text(indexCard?.id) || undefined,
  };

  if (description) job.description = description;

  const postedAt = toEpochMs(posting.datePosted);
  if (postedAt !== undefined) job.postedAt = postedAt;

  // The band is the BOARD's own filed figure, not the employer's. Measured
  // 2026-10-28: card 36883 (Schoolhouse.world, "Software Engineer") files
  // $167K-$207K in its JSON-LD while the employer's Ashby posting for the same
  // requisition publishes no compensation at all. The parser is reading the
  // right block — one JobPosting block on the page, the same band the index
  // card shows — so the disagreement is between the board and the employer,
  // not between the card and the JSON-LD. The figure is still carried, because
  // a board figure the employer never published is evidence, just not proof.
  //
  // The provenance rides on `note` — an existing scanner seam that
  // formatPipelineOffer already renders as a labeled `| note: ...` segment —
  // not on a new scan.mjs segment. scan.mjs sits in the updater's manifest and
  // is reverted by any update, while this provider file is not, so a caveat
  // written here survives one.
  const salary = salaryFrom(posting);
  if (salary) {
    job.salary = salary;
    job.note = 'board-filed comp, verify at employer';
  }

  if (job.externalId === undefined) delete job.externalId;

  return job;
}

/** @type {Provider} */
export default {
  id: 'techjobsforgood',

  // A URL-pattern detect(): the board has a single natural landing URL and its
  // own distinct host, so a `careers_url` on this host is claimed directly.
  // An explicit `provider: techjobsforgood` bypasses this and works with no
  // careers_url at all.
  detect(entry) {
    if (entry?.provider === 'techjobsforgood') return { url: INDEX_URL };
    const raw = entry?.careers_url ?? entry?.api;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (!isBoardHost(parsed.hostname)) return null;
    return { url: INDEX_URL };
  },

  async fetch(entry, ctx) {
    // `ctx.maxPages` is the caller-side bound (verify-portals probes with 1)
    // in units of INDEX pages; the per-posting card walk is skipped entirely
    // while probing — the probe only needs to know the board answers.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const ctxCap = probing ? Number(ctx.maxPages) : Infinity;
    const pagesToFetch = Math.max(1, Math.min(resolveMaxPages(entry), ctxCap));

    const headers = { accept: 'text/html,application/xhtml+xml' };

    /** @type {Map<string, {id: string, title: string, company: string, location: string, url: string}>} */
    const cards = new Map();
    /** @type {'complete'|'cap'|'fetch-error'} */
    let stopReason = 'complete';
    let statedCount = 0;
    let sawCardMarkup = false;

    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let html;
      try {
        html = await fetchTextWithRetry(ctx, `${INDEX_URL}?page=${page}`, {
          headers,
          // Never follow a redirect: a 3xx could point at an internal address
          // after the IP guard passed the original host.
          redirect: 'error',
        });
      } catch (err) {
        // A 404 past the last page is the board's natural end, not a failure.
        if (err?.status === 404) {
          stopReason = 'complete';
          break;
        }
        // While probing, a ctx.fetch* rejection must reach verify-portals
        // unwrapped — it identifies its own request budget by error identity.
        if (probing) throw err;
        stopReason = 'fetch-error';
        console.error(
          `⚠️  techjobsforgood: ${entry?.name} stopped on index page ${page} (${err?.message}); returning what was parsed`,
        );
        break;
      }

      const parsed = parseIndexPage(html);
      statedCount = Math.max(statedCount, parsed.statedCount);
      sawCardMarkup = sawCardMarkup || parsed.sawCardMarkup;

      let fresh = 0;
      for (const card of parsed.cards) {
        if (cards.has(card.id)) continue;
        cards.set(card.id, card);
        fresh++;
      }

      if (parsed.rawCardCount === 0 || fresh === 0) {
        stopReason = 'complete';
        break;
      }
      // The short-page stop reads the count the SOURCE rendered, before any
      // card was dropped, so one malformed card cannot end the walk early.
      if (parsed.rawCardCount < PAGE_SIZE) {
        stopReason = 'complete';
        break;
      }
      if (page === pagesToFetch) stopReason = 'cap';
    }

    // Plausible-parse guard: a board that still advertises postings but yields
    // no id at all is a markup change, not an empty board. Neither the signal
    // nor the cards present means a genuinely empty board.
    if (cards.size === 0) {
      if (sawCardMarkup || statedCount > 0) {
        throw new Error(
          `techjobsforgood: ${INDEX_URL} advertises ${statedCount || 'postings'} but no posting id could be parsed — the listing markup changed`,
        );
      }
      return [];
    }

    // Probe: the index alone is enough to prove the board answers. Exactly one
    // list request, no per-posting fan-out.
    if (probing) {
      return [...cards.values()]
        .map((card) => ({ title: card.title, url: card.url, company: card.company, location: card.location }))
        .filter((job) => job.title !== '' && job.url !== '');
    }

    const ids = [...cards.keys()];
    /** @type {({title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: {min: number, max: number, currency?: string}, externalId?: string} | null)[]} */
    const results = new Array(ids.length).fill(null);
    // Expired postings answer 200 with no JobPosting block; that is the source's
    // own liveness signal, counted separately from a transport failure.
    let skippedNoBlock = 0;
    let skippedInvalid = 0;
    let fetchFailures = 0;
    /** @type {string[]} */
    const failureMessages = [];

    for (let i = 0; i < ids.length; i += CARD_CONCURRENCY) {
      if (i > 0) await sleep(INTER_CARD_BATCH_DELAY_MS, ctx);
      const batch = ids.slice(i, i + CARD_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (id, offset) => {
          const indexCard = cards.get(id);
          let html;
          try {
            html = await fetchTextWithRetry(ctx, indexCard.url, { headers, redirect: 'error' });
          } catch (err) {
            if (failureMessages.length < 3) failureMessages.push(`${indexCard.url} (${err?.message})`);
            return { index: i + offset, job: null, outcome: 'fetch-failure' };
          }
          const parsed = parseJobCard(html);
          if (!parsed.posting) return { index: i + offset, job: null, outcome: 'no-block' };
          const job = normalizeJob(parsed, indexCard);
          return { index: i + offset, job, outcome: job ? 'ok' : 'invalid' };
        }),
      );
      for (const entryResult of settled) {
        results[entryResult.index] = entryResult.job;
        if (entryResult.outcome === 'no-block') skippedNoBlock++;
        else if (entryResult.outcome === 'invalid') skippedInvalid++;
        else if (entryResult.outcome === 'fetch-failure') fetchFailures++;
      }
    }

    const skipped = skippedNoBlock + skippedInvalid + fetchFailures;
    // One malformed card is skipped; EVERY card missing its JSON-LD is the card
    // template changing under the provider, and a silent empty board is the
    // failure mode that makes a scraper untrustworthy.
    if (skipped === ids.length) {
      throw new Error(
        `techjobsforgood: all ${ids.length} posting card(s) yielded no record (${skippedNoBlock} with no JobPosting block, ${fetchFailures} fetch failure(s), ${skippedInvalid} unusable) — the card markup changed`,
      );
    }
    if (skipped > 0) {
      console.error(
        `⚠️  techjobsforgood: ${entry?.name} skipped ${skipped} of ${ids.length} card(s) — ${skippedNoBlock} with no JobPosting block (expired), ${fetchFailures} fetch failure(s), ${skippedInvalid} unusable${failureMessages.length ? `; e.g. ${failureMessages[0]}` : ''}`,
      );
    }

    if (stopReason === 'cap') {
      console.error(
        `⚠️  techjobsforgood: ${entry?.name} truncated at max_pages=${pagesToFetch} (${cards.size} postings) — raise max_pages on this entry for more`,
      );
    }

    // Dedup on the posting id (already unique in `cards`), then on the emitted
    // URL: the apply URL is the scanner's dedup key, and a repeat would collapse
    // two rows downstream.
    /** @type {any[]} */
    const out = [];
    const seenUrls = new Set();
    for (const job of results) {
      if (!job) continue;
      if (seenUrls.has(job.url)) continue;
      seenUrls.add(job.url);
      out.push(job);
    }
    return out;
  },
};
