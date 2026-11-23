// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Words of Mouth provider — words of mouth.org, one editor's weekly curated
// newsletter of opportunities "across art, design, research, information, and
// the built environment" (Rachel Meade Smith, weekly since 2016, US-heavy:
// New York, Los Angeles, San Francisco, Boston, Philadelphia). Wire in via a
// `job_boards:` entry with `provider: wordsofmouth`; the optional
// `recent_issues:` key overrides how many of the newest issues are read.
//
// WHY THIS IS A SCRAPER. This source has no feed of any kind: no RSS/Atom
// (`wordsofmouth.beehiiv.com/feed` and `/rss` both 404), and the listing data
// squarespace would hand out — `/archive?format=json` — is `Disallow`ed for
// `User-agent: *` in robots.txt (`Disallow:/*?format=json`), so it is off
// limits by rule 6. The HTML paths this provider reads (`/archive`, and the
// issue pages under beehiiv / mailchi.mp) carry no `Disallow`. Measured
// 2026-10-27.
//
// THE WALK IS DELIBERATELY BOUNDED, and that is the design decision here.
// `/archive` is a single server-rendered page linking ~94 recent issues, and
// nine `/archive-{year}` pages reach back to 2016 — ~495 issues in all, at
// 100 KB-1 MB each, i.e. hundreds of megabytes per scan. A weekly issue's
// listings go stale within weeks, so reading the whole 2016-to-now archive
// buys nothing but cost. This provider therefore reads the newest
// `recent_issues` issues (default 4, roughly the last month) off the single
// `/archive` page — that page is already newest-first, so no year page is
// fetched and no pagination is involved. The bound is a named constant below,
// tunable per entry, and capped so one entry cannot sweep the archive.
//
// THREE PLATFORMS, ONE MARKUP CONTRACT. Issue pages have migrated twice
// (campaign-archive → mailchi.mp → beehiiv) and are still split across all
// three hosts. What all of them emit is the same editor-typed rich-text block:
//
//   What:      <a href="{posting}">Artistic Director</a>
//   Who:       <a href="{employer}">The Apollo</a> celebrates, creates, …
//   Where:     New York, NY
//   How much:  $250-285k → <a href="mailto:…">contact submitter directly</a>
//
// So the parser keys off the four LABELS (which survive a template rebuild far
// better than class names or element order) and nothing positional. Sections
// are marked the same way — `Jobs`, `Classifieds`, `Calls` — and only the
// `Jobs` section is read; Classifieds are ads and Calls are open calls for
// submissions, neither of which is a job.
//
// User-Agent: beehiiv answers 403 (Cloudflare "Just a moment…") to the plain
// `career-ops` UA and 200 to a browser-like one, so every request here uses the
// repo's shared `BROWSER_LIKE_USER_AGENT`. That is a WAF/UA separation, not
// impersonation: the same shared identity every other WAF-gated provider in
// this tree uses, and robots.txt governs what may be fetched, not which UA
// string asks for it.
//
// POLICY NOTE (rule 3, not a blocker). The operator *requests* a $75-$100
// donation from every accepted submitter and states publication is never
// conditional on it; no paid ranking or promoted slot was observed. Recorded
// here for a maintainer reviewing the source, since it is the one thing about
// this source that is not an automatic pass.
//
// WHAT THIS PARSER CANNOT RECOVER (fields left empty rather than guessed):
//   - `company` when the `Who:` sentence opens with prose instead of an
//     employer link — the employer is free text there, and inventing one is
//     worse than an empty field.
//   - `location` when the issue carries no `Where:` line at all.
//   - salary: `How much:` is free text ("$250-285k", "competitive"); it is not
//     parsed into `salary`, because a range like that says nothing about
//     currency basis or full-time equivalence.
//   - per-listing dates: there are none. `postedAt` is the ISSUE date, which is
//     the only date the source publishes.
//   - a listing whose only apply channel is a Cloudflare-obfuscated `mailto:`
//     (`/cdn-cgi/l/email-protection#…`) AND whose `What:` link is missing has no
//     fetchable destination, so it is skipped: `Job.url` is the dedup key and
//     the issue URL would collide every such listing onto one row.

import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry, sleep } from './_http.mjs';
import { decodeEntities } from './_html-entities.mjs';

const INDEX_URL = 'https://www.wordsofmouth.org/archive';
const INDEX_HOST = 'www.wordsofmouth.org';

/** Issue-page hosts, allowlisted because every issue URL comes from scraped HTML. */
const ISSUE_HOSTS = new Set(['wordsofmouth.beehiiv.com', 'mailchi.mp']);

/** The 2016-17 issues sit on Mailchimp's per-tenant campaign archive host. */
const CAMPAIGN_ARCHIVE_HOST_RE = /^us\d+\.campaign-archive\d*\.com$/;

/**
 * How many of the newest issues to read. Four covers roughly the last month of
 * a weekly newsletter — long enough that a scan every few days cannot miss an
 * issue, short enough that a scan stays in the low single-digit MB. Listings in
 * this source are explicitly "current openings"; four weeks is already generous.
 */
const DEFAULT_RECENT_ISSUES = 4;

/** Hard ceiling on a configured `recent_issues`, independent of any entry value. */
const MAX_RECENT_ISSUES = 12;

/**
 * Pacing between issue fetches. Each issue is 100 KB-1 MB from a CDN, and this
 * provider issues at most a dozen sequential requests per run, so this is
 * courtesy rather than a measured throttle — no 429 was observed while probing.
 */
const INTER_ISSUE_DELAY_MS = 500;

/** Section headings; only `Jobs` is read (see the header comment). */
const JOBS_HEADING_RE = /(?:^|\n)[ \t]*jobs[ \t]*(?:\n|$)/i;
const NEXT_SECTION_RE =
  /(?:^|\n)[ \t]*(?:support|services|collaboration|collaborations|classifieds|calls|sponsors?|sponsored)[ \t]*(?:\n|$)/i;

/** Anchor splitter, reused by the index and issue parsers. */
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/** Marker characters for an extracted link: href, then its visible text. */
const LINK_OPEN = '\u0001';
const LINK_MID = '\u0002';
const LINK_CLOSE = '\u0003';
const LINK_MARK_RE = /\u0001([^\u0002]*)\u0002([^\u0003]*)\u0003/g;

/** `What:` opens a listing block; `Who:` / `Where:` / `How much:` fill it. */
const WHAT_LABEL_RE = /(?:^|\n)[ \t]*what[ \t]*:[ \t]*/gi;
const SUB_LABEL_RE = /(?:^|\n)[ \t]*(who|where|how much)[ \t]*:[ \t]*/gi;

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isIssueHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return ISSUE_HOSTS.has(host) || CAMPAIGN_ARCHIVE_HOST_RE.test(host);
}

/**
 * Read an `href` out of a raw attribute string.
 * @param {string} attrs
 * @returns {string}
 */
function hrefFromAttrs(attrs) {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(attrs ?? ''));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

/**
 * Normalize a scraped issue href into an absolute https URL on an allowlisted
 * host, or null. This is the SSRF guard for the issue walk: the URL is built
 * from page data, so the hostname is checked before any request goes out, and
 * the scheme is rebuilt rather than trusted (`http:` mailchi.mp links from the
 * 2016-17 era are upgraded here).
 *
 * The archive's own markup sometimes emits a doubled scheme
 * (`href="https://  https://wordsofmouth.beehiiv.com/p/…"`, observed live
 * 2026-10-27), so the href is re-anchored at its LAST `http(s)://`.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeIssueHref(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const m = /https?:\/\//gi;
  let last = -1;
  let hit;
  while ((hit = m.exec(value)) !== null) last = hit.index;
  if (last < 0) return null;
  const candidate = value.slice(last);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!isIssueHost(parsed.hostname)) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  // The path is opaque here — only the host is a trust boundary, and the scheme
  // is rebuilt so a `http:` link cannot downgrade the request.
  return `https://${host}${parsed.pathname}${parsed.search}`;
}

/**
 * Collapse one HTML fragment to plain text, decoding entities.
 * @param {string} fragment
 * @returns {string}
 */
function plainText(fragment) {
  const marked = String(fragment ?? '').replace(ANCHOR_RE, (_all, attrs, inner) =>
    `${LINK_OPEN}${hrefFromAttrs(attrs)}${LINK_MID}${plainText(inner)}${LINK_CLOSE}`);
  return decodeEntities(marked.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Convert an issue page into the label-addressable text stream the block parser
 * reads: every anchor becomes a marker carrying its href and text, block-level
 * tags become newlines (so labels line up at line starts), and everything else
 * is stripped and entity-decoded.
 * @param {string} html
 * @returns {string}
 */
export function toLabelText(html) {
  const marked = String(html ?? '').replace(ANCHOR_RE, (_all, attrs, inner) => {
    const text = String(inner ?? '').replace(/<[^>]*>/g, ' ');
    return `${LINK_OPEN}${hrefFromAttrs(attrs)}${LINK_MID}${text}${LINK_CLOSE}`;
  });
  const blocky = marked.replace(
    /<\/?(?:p|div|br|hr|li|ul|ol|tr|td|th|table|tbody|thead|h[1-6]|blockquote|section|article)\b[^>]*>/gi,
    '\n',
  );
  return decodeEntities(blocky.replace(/<[^>]*>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ');
}

/**
 * Parse the newsletter's date label — `Week of 10/26/26`, `1/17/25: Hire an
 * Angeleno!` — into epoch ms (UTC midnight). An unreadable label returns
 * undefined: `postedAt` is optional, and a guessed date would be a fabricated
 * claim about a real posting.
 * @param {string} label
 * @returns {number | undefined}
 */
export function parseIssueDate(label) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(label ?? ''));
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const rawYear = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const year = m[3].length === 2 ? 2000 + rawYear : rawYear;
  if (year < 2000 || year > 2100) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Extract the issue links from `/archive`, newest first (the page's own DOM
 * order — it is a reverse-chronological index, verified live on 2026-10-27).
 * Links to anything that is not an issue page are dropped by the host
 * allowlist; duplicates (the same issue linked twice with different tracking
 * or a stray id suffix) are collapsed on host + path.
 *
 * @param {string} html
 * @returns {{url: string, postedAt?: number}[]}
 */
export function parseIndexPage(html) {
  const source = String(html ?? '');
  /** @type {{url: string, postedAt?: number}[]} */
  const issues = [];
  const seen = new Set();
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(source)) !== null) {
    const url = normalizeIssueHref(hrefFromAttrs(m[1]));
    if (!url) continue;
    const key = new URL(url).hostname.toLowerCase().replace(/\.$/, '') + new URL(url).pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const postedAt = parseIssueDate(plainText(m[2]));
    issues.push(postedAt === undefined ? { url } : { url, postedAt });
  }
  return issues;
}

/**
 * Cut a label-text stream down to its `Jobs` section. Sections are separated by
 * standalone heading lines (`Jobs`, `Classifieds`, `Calls`, …); when no `Jobs`
 * heading is present (the pre-2019 Mailchimp template has none) the whole
 * stream is read, and the block parser's own label requirement keeps prose out.
 * @param {string} text
 * @returns {string}
 */
function jobsRegion(text) {
  const heading = JOBS_HEADING_RE.exec(text);
  const region = heading ? text.slice(heading.index) : text;
  const next = NEXT_SECTION_RE.exec(region);
  return next ? region.slice(0, next.index) : region;
}

/**
 * @param {string} segment
 * @returns {{href: string, text: string}[]}
 */
function linksIn(segment) {
  /** @type {{href: string, text: string}[]} */
  const links = [];
  LINK_MARK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_MARK_RE.exec(segment)) !== null) {
    links.push({ href: m[1], text: decodeEntities(m[2]).replace(/\s+/g, ' ').trim() });
  }
  return links;
}

/**
 * Visible text of a segment, markers replaced by their labels.
 * @param {string} segment
 * @returns {string}
 */
function segmentText(segment) {
  return decodeEntities(
    String(segment ?? '').replace(LINK_MARK_RE, (_all, _href, text) => ` ${text} `),
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Resolve a scraped href into an absolute http(s) destination, or null.
 * `mailto:` and Cloudflare's obfuscated `mailto` (`/cdn-cgi/l/email-protection#…`)
 * carry no fetchable posting, and a relative href is resolved against the issue
 * page (both platforms link employer pages absolutely; this is defensive).
 * @param {string} href
 * @param {string} issueUrl
 * @returns {string | null}
 */
function absolutePostingUrl(href, issueUrl) {
  const raw = String(href ?? '').trim();
  if (!raw) return null;
  if (/^mailto:/i.test(raw)) return null;
  if (/\/cdn-cgi\/l\/email-protection/i.test(raw)) return null;
  let parsed;
  try {
    parsed = new URL(raw, issueUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Pick the posting destination for one listing block: the `What:` link (the
 * posting or its ATS page) when it is a real http(s) destination, else the
 * `Who:` link (the employer's own site) — rule 2's "shortest verifiable path to
 * the employer". Both missing → the listing has no destination and is skipped.
 * @param {string} titleSegment
 * @param {string} whoSegment
 * @param {string} issueUrl
 * @returns {string | null}
 */
function pickPostingUrl(titleSegment, whoSegment, issueUrl) {
  for (const link of linksIn(titleSegment).concat(linksIn(whoSegment))) {
    const url = absolutePostingUrl(link.href, issueUrl);
    if (url) return url;
  }
  return null;
}

/**
 * Employer name from the `Who:` segment. The `Who:` link normally wraps the
 * employer's name and the sentence follows it (`<a>Bellweather</a> makes
 * identities…`). When prose opens the sentence instead, the link's text is not
 * necessarily the employer, so the field is left empty rather than guessed —
 * `company` is optional and an empty value is honest.
 * @param {string} whoSegment
 * @returns {string}
 */
function pickCompany(whoSegment) {
  LINK_MARK_RE.lastIndex = 0;
  const first = LINK_MARK_RE.exec(whoSegment);
  if (!first) return '';
  const before = whoSegment.slice(0, first.index).replace(/[ \t]+/g, '');
  if (before) return '';
  const name = decodeEntities(first[2]).replace(/\s+/g, ' ').trim();
  // A link that is the apply channel, not the employer.
  if (!name || /^mailto:/i.test(first[1]) || /contact|apply|email/i.test(name)) return '';
  return name.length > 120 ? '' : name;
}

/**
 * Parse one issue page into postings.
 *
 * Blocks are split on the `What:` label and each block is filled from its
 * `Who:` / `Where:` / `How much:` segments. A block needs a title and a
 * fetchable destination to become a row; anything else is skipped, never
 * guessed at.
 *
 * Broken-vs-empty: an issue that still carries `What:`/`Who:` labels but yields
 * no recognizable block at all is a markup change and THROWS — a parser that
 * silently returns nothing is the failure mode that makes scrapers untrustworthy.
 * An issue with no such labels (a special edition with no Jobs section) is
 * legitimately empty and returns [].
 *
 * @param {string} html - Raw issue page.
 * @param {{issueUrl?: string, postedAt?: number}} [opts]
 * @returns {{title: string, url: string, company: string, location: string, postedAt?: number}[]}
 */
export function parseIssuePage(html, opts = {}) {
  const issueUrl = opts.issueUrl ?? INDEX_URL;
  const region = jobsRegion(toLabelText(html));

  /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}[]} */
  const jobs = [];
  let recognizedBlocks = 0;

  const starts = [];
  WHAT_LABEL_RE.lastIndex = 0;
  let m;
  while ((m = WHAT_LABEL_RE.exec(region)) !== null) starts.push(m.index + m[0].length);

  for (let i = 0; i < starts.length; i++) {
    const block = region.slice(starts[i], starts[i + 1] ?? region.length);

    // Locate the sub-labels inside this block.
    /** @type {{key: string, start: number, body: number}[]} */
    const labels = [];
    SUB_LABEL_RE.lastIndex = 0;
    let sub;
    while ((sub = SUB_LABEL_RE.exec(block)) !== null) {
      labels.push({ key: sub[1].toLowerCase(), start: sub.index, body: sub.index + sub[0].length });
    }
    const firstLabel = labels[0];
    if (!firstLabel) continue; // prose mentioning "What:", not a listing

    const titleSegment = block.slice(0, firstLabel.start);
    const at = (key) => labels.find((l) => l.key === key);
    const whoLabel = at('who');
    const whereLabel = at('where');

    const titleLinks = linksIn(titleSegment);
    const title = titleLinks.length > 0
      ? titleLinks[0].text
      : segmentText(titleSegment);
    if (!title) continue;

    const whoSegment = whoLabel
      ? block.slice(whoLabel.body, whereLabel ? whereLabel.start : block.length)
      : '';
    const whereSegment = whereLabel
      ? block.slice(whereLabel.body, (at('how much')?.start ?? block.length))
      : '';

    // `<Who …><Where …>` is the structural signature of a listing; without at
    // least one of them this is a paragraph that happens to contain "What:".
    if (!whoLabel && !whereLabel) continue;
    recognizedBlocks++;

    const url = pickPostingUrl(titleSegment, whoSegment, issueUrl);
    if (!url) continue;

    const location = segmentText(whereSegment.split('→')[0]).slice(0, 160);
    const job = {
      title,
      url,
      company: whoLabel ? pickCompany(whoSegment) : '',
      location,
      ...(opts.postedAt !== undefined ? { postedAt: opts.postedAt } : {}),
    };
    jobs.push(job);
  }

  if (recognizedBlocks === 0 && /what\s*:/i.test(region) && /who\s*:/i.test(region)) {
    throw new Error(
      `wordsofmouth: ${issueUrl} still carries What/Who labels but no listing could be parsed — the issue markup changed`,
    );
  }
  return jobs;
}

/**
 * Resolve how many issues to read, honouring `recent_issues` on the entry and
 * capping it independently of anything the entry says.
 * @param {{recent_issues?: number}} [entry]
 * @returns {number}
 */
export function resolveRecentIssues(entry) {
  const v = entry?.recent_issues;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_RECENT_ISSUES);
  return DEFAULT_RECENT_ISSUES;
}

/** @type {Provider} */
export default {
  id: 'wordsofmouth',

  // Explicit-only: the source is one newsletter, and no per-company URL could
  // claim it. A `provider: wordsofmouth` entry in `job_boards:` is the only way
  // in, so this never claims a board the user did not point at it.
  detect(entry) {
    return entry?.provider === 'wordsofmouth' ? { url: INDEX_URL } : null;
  },

  async fetch(entry, ctx) {
    // `ctx.maxPages` is the caller-side bound (verify-portals probes with 1);
    // "pages" for this provider are issues, since the index is a single page.
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    const maxIssues = Math.min(resolveRecentIssues(entry), probing ? ctx.maxPages : Infinity);

    const headers = { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html,*/*' };

    const indexHtml = await fetchTextWithRetry(ctx, INDEX_URL, { headers, redirect: 'error' });
    const issues = parseIndexPage(indexHtml);
    if (issues.length === 0) {
      throw new Error(
        `wordsofmouth: ${INDEX_URL} carried no issue links on an allowlisted host — the archive markup changed`,
      );
    }

    const picked = issues.slice(0, maxIssues);
    /** @type {{title: string, url: string, company: string, location: string, postedAt?: number}[]} */
    const jobs = [];
    const seen = new Set();
    /** @type {Error[]} */
    const failures = [];

    for (let i = 0; i < picked.length; i++) {
      if (i > 0) await sleep(INTER_ISSUE_DELAY_MS, ctx);
      const issue = picked[i];
      try {
        const html = await fetchTextWithRetry(ctx, issue.url, { headers, redirect: 'error' });
        for (const job of parseIssuePage(html, { issueUrl: issue.url, postedAt: issue.postedAt })) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          jobs.push(job);
        }
      } catch (err) {
        // While probing, a transport rejection must propagate unwrapped so
        // verify-portals recognizes its own request-budget cut-off.
        if (probing) throw err;
        // Recall-first in a real scan: one dead issue must not lose the rest.
        failures.push(/** @type {Error} */ (err));
      }
    }

    if (failures.length === picked.length) {
      throw new Error(`wordsofmouth: every issue fetch failed — ${failures[0].message}`);
    }
    return jobs;
  },
};
