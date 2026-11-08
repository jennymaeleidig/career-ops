// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// CFengage provider — the "Nonprofit Job Finder" board run by the Community
// Foundation for a greater Richmond (cfengage.org/Jobs). It is a HandsOn
// Connect portal (ASP.NET over Salesforce `Job_Posting__c` records) and a
// MULTI-EMPLOYER board, so it belongs under `job_boards:` in portals.yml, not
// `tracked_companies:`.
//
// The /Jobs page ships an empty result grid and fills it from one platform
// route, which is what this provider reads:
//
//   POST https://www.cfengage.org/admin/GetSalesforceViewRecords
//     blockId, Sfobject, Sfview, formatToDisplay=GRID, listingCmsId,
//     limit, offset, …
//   -> { status: "ok", records: [ { Columns: [ { FieldNameOrPath, Value } ] } ],
//        columns, dynamicFacetsData, recordsDeleted, lastFetchTime }
//
// It is anonymous (no cookies, no CSRF, no auth), but it is a POST: the same
// route answers `GET` with `{}`. `Columns` is a flat name/value array rather
// than an object, so each row is folded before it is read. The record's
// Salesforce `Sfview` is case-sensitive — one wrong-cased character in it makes
// the route answer a well-formed, empty `{}` instead of anything useful.
//
// The board publishes title, employer, location, salary, posted date, the full
// JD HTML and the employer's own apply URL in this one payload, so no
// per-posting request is ever made. The site's per-posting detail page
// (`/job-posting-connector/p/{Id}/{slug}`) is login-walled for anonymous
// visitors; the JSON is not. Never fetch a detail page.
//
// `Job.url` is that detail page, not the employer's apply URL, because the
// apply URL is shared by sibling postings (measured live: 49 postings over 40
// distinct employer URLs, one careers page linked by five of them) and
// `Job.url` is the scanner's dedup key — keying on it would collapse five
// distinct openings into one row. The employer's own link is carried in the
// description instead, where it stays visible without becoming an identity.
//
// Tenant config (the three ids are HandsOn Connect block/view values, not
// derivable from the board URL) goes on the entry:
//
//   job_boards:
//     - name: CFengage (Greater Richmond nonprofit jobs)
//       provider: cfengage
//       careers_url: https://www.cfengage.org/Jobs
//       cfengage:
//         block_id: 71734
//         view_id: 00B5c000006PDKzEAO
//         listing_cms_id: 6355
//       enabled: true

import { fetchJsonWithRetry, sleep } from './_http.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { parseAnnualCompensation, compensationCurrency } from './_salary-text.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';
import { coerceId } from './_ids.mjs';

const ORIGIN = 'https://www.cfengage.org';
const ENDPOINT = `${ORIGIN}/admin/GetSalesforceViewRecords`;
const DETAIL_PATH = '/job-posting-connector/p';
const FIELDS = {
  title: 'Job_Title__c',
  name: 'Name',
  employer: 'Posting_Organization__r.Name',
  location: 'Location__c',
  jd: 'Job_Post_Description__c',
  posted: 'Approval_Date__c',
  created: 'CreatedDate',
  applyUrl: 'More_Info_URL__c',
  salary: 'Salary_calculated__c',
  slug: 'Job_Posting_Slug__c',
  id: 'Id',
};

// The board's own page size. Live: 49 postings in one page at limit=100, and
// limit=9&offset=9 paginates 9 at a time, so the route honours both.
const PAGE_SIZE = 100;
// The board is a rolling ~30-day window that has never exceeded one page;
// five is already generous headroom for a growth spurt before the cap warns.
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES_CAP = 100;
const INTER_PAGE_DELAY_MS = 250;

/**
 * The tenant ids from the portal entry, or nulls when an entry omits them.
 *
 * @param {any} entry
 * @returns {{ blockId: (string|undefined), viewId: (string|undefined), listingCmsId: (string|undefined) }}
 */
function boardConfig(entry) {
  const block = entry?.cfengage && typeof entry.cfengage === 'object' ? entry.cfengage : {};
  return {
    blockId: coerceId(block.block_id),
    viewId: coerceId(block.view_id),
    listingCmsId: coerceId(block.listing_cms_id),
  };
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * Fold a record's flat `Columns` name/value array into an object.
 *
 * A Salesforce view can expose the same field twice — the raw value plus a
 * display-formatted variant whose name carries the format after a comma
 * (`Approval_Date__c,"M/d/yyyy"`). Only the raw name is kept: the formatted
 * twin is for the board's own card markup, and letting it overwrite the raw
 * value would hand the date parser a shape it has to guess about.
 *
 * @param {any} record
 * @returns {Record<string, any>}
 */
function columnsToObject(record) {
  /** @type {Record<string, any>} */
  const row = {};
  const columns = Array.isArray(record?.Columns) ? record.Columns : [];
  for (const column of columns) {
    const name = typeof column?.FieldNameOrPath === 'string' ? column.FieldNameOrPath : '';
    if (!name || name.includes(',')) continue;
    row[name] = column.Value;
  }
  return row;
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

/**
 * The employer's own application link, when the record carries a usable one.
 * Only `https:` is taken: a plain-`http:` link would downgrade the user's
 * session on the way to applying, and the board's data is not a trust anchor.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function employerApplyUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Normalize one CFengage record. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:      `Job_Title__c`, falling back to the record `Name`.
 *   - url:        the board's own per-posting page
 *                 `/job-posting-connector/p/{Id}/{slug}` — the dedup key, and
 *                 the only URL that is unique per posting.
 *   - company:    `Posting_Organization__r.Name`, falling back to the entry name.
 *   - location:   `Location__c` (free text: "Richmond", "Henrico County").
 *   - postedAt:   `Approval_Date__c`, falling back to `CreatedDate`.
 *   - salary:     `Salary_calculated__c`, only when it names an ANNUAL figure —
 *                 an hourly rate is left off rather than annualized from an
 *                 assumption about hours.
 *   - externalId: the Salesforce record `Id`.
 *   - description: the JD HTML flattened to text, with the employer's own
 *                 apply link appended.
 *
 * @param {any} record
 * @param {string} [fallbackCompany]
 * @returns {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: { min: number, max: number, currency?: string }, externalId?: string } | null}
 */
export function normalizeCfengageJob(record, fallbackCompany) {
  const row = columnsToObject(record);
  const title = text(row[FIELDS.title]) || text(row[FIELDS.name]);
  const id = coerceId(row[FIELDS.id]);
  if (!title || !id) return null;

  const idSegment = safeEncodeURIComponent(id);
  const slugSegment = safeEncodeURIComponent(text(row[FIELDS.slug]) || id);
  if (idSegment === null || slugSegment === null) return null;

  const jd = htmlToText(row[FIELDS.jd]);
  const applyUrl = employerApplyUrl(row[FIELDS.applyUrl]);
  const description = [jd, applyUrl ? `Apply: ${applyUrl}` : ''].filter(Boolean).join('\n\n');

  /** @type {{ title: string, url: string, company: string, location: string, description?: string, postedAt?: number, salary?: { min: number, max: number, currency?: string }, externalId?: string }} */
  const job = {
    title,
    url: `${ORIGIN}${DETAIL_PATH}/${idSegment}/${slugSegment}`,
    company: text(row[FIELDS.employer]) || fallbackCompany || 'CFengage',
    location: text(row[FIELDS.location]),
    externalId: id,
  };

  if (description) job.description = description;

  const postedAt = toEpochMs(row[FIELDS.posted]) ?? toEpochMs(row[FIELDS.created]);
  if (postedAt !== undefined) job.postedAt = postedAt;

  const salaryText = text(row[FIELDS.salary]);
  const amount = parseAnnualCompensation(salaryText);
  if (amount) {
    const currency = compensationCurrency(salaryText);
    job.salary = { min: amount.min, max: amount.max, ...(currency ? { currency } : {}) };
  }

  return job;
}

/**
 * The request body the board's own grid sends. Only `blockId`, `Sfobject`,
 * `Sfview`, `formatToDisplay`, `listingCmsId`, `limit` and `offset` are load
 * bearing (verified live: those seven alone return all 49 records), but the
 * rest is sent too so the request matches what the page issues and a stricter
 * platform build keeps accepting it.
 *
 * @param {{ blockId: string, viewId: string, listingCmsId: string }} config
 * @param {number} offset
 * @returns {string}
 */
function buildBody(config, offset) {
  return new URLSearchParams({
    blockId: config.blockId,
    Sfobject: 'Job_Posting__c',
    Sfview: config.viewId,
    ParametersUrl: '',
    formatToDisplay: 'GRID',
    listingCmsId: config.listingCmsId,
    totalItems: '0',
    limit: String(PAGE_SIZE),
    offset: String(offset),
    isEditable: 'False',
    calendarEventUrl: '',
    orderBy: 'Approval_Date__c',
    orderDirection: '1',
    rewriteParameters: '',
    objectNameRelatedFiles: '',
    relatedFilesId: '',
    FieldNameToObjectRelatedFiles: '',
    includeRelatedFiles: 'false',
    ParametersUrlEnforceOr: '',
    EnforcedbyContactOrAccount: 'False',
    AccountNameUserLogged: '',
    AutoRefresh: 'false',
    LastMaxSystemStamp: '',
    ChannelName: '',
    LastFetchTime: '',
    searchAutoSuggestFieldValue: '',
    RecordIds: '[]',
    AdditionalFields: '',
  }).toString();
}

/** @type {Provider} */
export default {
  id: 'cfengage',

  // Explicit-only: the board URL (cfengage.org/Jobs) shares no host pattern
  // with the platform route that carries the data, so there is nothing a
  // URL-pattern detect() could honestly match.
  detect(entry) {
    return entry?.provider === 'cfengage' ? { url: ENDPOINT } : null;
  },

  async fetch(entry, ctx) {
    const config = boardConfig(entry);
    if (!config.blockId || !config.viewId || !config.listingCmsId) {
      throw new Error(
        `cfengage: ${entry?.name} needs cfengage.block_id, cfengage.view_id and cfengage.listing_cms_id in portals.yml`,
      );
    }

    const ctxMaxPages = Number(ctx?.maxPages);
    const probing = ctxMaxPages > 0;
    const pagesToFetch = Math.min(resolveMaxPages(entry), probing ? ctxMaxPages : Infinity);

    /** @type {any[]} */
    const out = [];
    const seenIds = new Set();
    let truncated = false;

    for (let page = 0; page < pagesToFetch; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      let json;
      try {
        json = await fetchJsonWithRetry(ctx, ENDPOINT, {
          method: 'POST',
          // redirect:'error' so a 3xx from the board host can never be followed
          // to an internal address after the IP guard passed the original host.
          redirect: 'error',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
            referer: `${ORIGIN}/Jobs`,
            accept: 'application/json, text/plain, */*',
          },
          body: buildBody(config, page * PAGE_SIZE),
        });
      } catch (err) {
        // While probing, a ctx.fetch* rejection has to reach verify-portals
        // unwrapped — it identifies its own request budget by error identity,
        // and swallowing or re-wrapping it would read a healthy board as dead.
        if (probing) throw err;
        console.error(
          `⚠️  cfengage: ${entry?.name} stopped on page ${page + 1} (${err?.message}); returning ${out.length} posting(s)`,
        );
        return out;
      }

      const records = json && Array.isArray(json.records) ? json.records : null;
      if (!records) {
        const got = json && typeof json === 'object' ? Object.keys(json).join(', ') : typeof json;
        throw new Error(`cfengage: unexpected response — expected records[], got: [${got}]`);
      }

      for (const record of records) {
        const job = normalizeCfengageJob(record, entry?.name);
        if (!job) continue;
        const id = job.externalId || job.url;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        out.push(job);
      }

      // The short-page stop reads the count the SOURCE returned, before any row
      // is dropped, so one malformed row cannot end the walk early.
      if (records.length < PAGE_SIZE) return out;
      if (page === pagesToFetch - 1) truncated = true;
    }

    if (truncated && !probing) {
      console.error(
        `⚠️  cfengage: ${entry?.name} truncated at max_pages=${pagesToFetch} (${out.length} postings) — raise max_pages on this entry for more`,
      );
    }
    return out;
  },
};
