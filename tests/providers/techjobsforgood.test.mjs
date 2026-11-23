// tests/providers/techjobsforgood.test.mjs — direct provider-contract tests.
// Tech Jobs for Good is a server-rendered Django board: the free index
// (/jobs/?page=N) lists the complete live inventory, and each posting's card
// (/jobs/{id}/) carries a schema.org JobPosting JSON-LD block plus the
// employer's ATS apply URL inline. The tests cover the two-step walk, the
// empty-vs-broken split (the index's card markup, the card's JSON-LD block),
// the expired-card skip, pagination, and probe cooperation.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nProvider — techjobsforgood');

const INDEX_HTML = readFileSync(join(ROOT, 'tests/fixtures/techjobsforgood-index.html'), 'utf-8');
const CARD_HTML = readFileSync(join(ROOT, 'tests/fixtures/techjobsforgood-card.html'), 'utf-8');
const EXPIRED_HTML = readFileSync(join(ROOT, 'tests/fixtures/techjobsforgood-card-expired.html'), 'utf-8');

const ENTRY = {
  name: 'Tech Jobs for Good',
  provider: 'techjobsforgood',
  careers_url: 'https://techjobsforgood.com/jobs/',
};

const INDEX_URL = 'https://techjobsforgood.com/jobs/';
const pageUrl = (n) => `${INDEX_URL}?page=${n}`;
// Index-page requests are the only ones carrying a `?page=` query; a card URL
// shares the `/jobs/` prefix, so the two cannot be told apart by prefix alone.
const PAGE_PREFIX = `${INDEX_URL}?page=`;
const cardUrl = (id) => `https://techjobsforgood.com/jobs/${id}/`;

/**
 * A ctx stub: no wall-clock waiting, no network. `routes` maps a URL to a body
 * string, an Error to throw, or a function (url, opts) => body. An unrouted URL
 * throws, so a request the test did not expect fails loudly.
 */
function makeCtx(routes) {
  const calls = [];
  return {
    calls,
    transport: 'http',
    sleep: async () => {},
    async fetchText(url, opts) {
      calls.push({ url, opts });
      const route = routes[url];
      if (route === undefined) throw new Error(`unexpected request: ${url}`);
      if (route instanceof Error) throw route;
      return typeof route === 'function' ? route(url, opts) : route;
    },
  };
}

/** One index card in the board's real markup, for generated pages. */
function indexCard(id, title = `Role ${id}`, company = 'Acme Nonprofit', location = 'Remote (US)') {
  return `<div class="ui raised fluid card job-card" style="box-shadow: 0 0 0 1px #d4d4d5;">
      <a class="content" href="/jobs/${id}/?ref=homepage">
        <div class="header job-title" title="${title}" style="font-size: 20px;">${title}</div>
        <div class="meta company-name" title="${company}"><span class="company_name">${company}</span></div>
        <div class="loc-and-sal" title="${location}"><span class="location" title="${location}">${location}</span></div>
      </a>
    </div>`;
}

/** One index page carrying `ids` as cards. */
function indexPage(ids) {
  return `<div class="sixteen wide centered column">\n${ids.map((id) => indexCard(id)).join('\n')}\n</div>
<p>${ids.length} jobs found</p>`;
}

/**
 * One posting card. `opts` overrides the pieces the mapping tests vary with:
 * the apply URL, the salary unit, or removing the JSON-LD block entirely.
 */
function cardHtml(id, opts = {}) {
  const {
    applyUrl = `https://ats.example.org/acme/jobs/${id}`,
    unitText = 'YEAR',
    withBlock = true,
  } = opts;
  const block = withBlock
    ? `<script type="application/ld+json">
    {
      "@context": "http://schema.org/",
      "@type": "JobPosting",
      "datePosted": "2026-10-01",
      "description": "<p>Build &amp; ship <strong>accessible</strong> tools.</p>",
      "hiringOrganization": { "@type": "Organization", "name": "Acme Nonprofit" },
      "title": "Role ${id}",
      "baseSalary": { "@type": "MonetaryAmount", "currency": "USD",
        "value": { "@type": "QuantitativeValue", "minValue": 90000, "maxValue": 110000, "unitText": "${unitText}" } },
      "jobLocationType": "TELECOMMUTE",
      "applicantLocationRequirements": { "@type": "Country", "name": "USA" }
    }
    </script>`
    : '';
  return `<html><head>${block}</head><body>
    <script>window.open('${applyUrl}', target = '_blank');</script>
  </body></html>`;
}

/** Every card of `ids` routed to a distinct, usable card page. */
function cardRoutes(ids, opts = {}) {
  return Object.fromEntries(ids.map((id) => [cardUrl(id), cardHtml(id, typeof opts === 'function' ? opts(id) : opts)]));
}

try {
  const techjobsforgood = (await import(pathToFileURL(join(ROOT, 'providers/techjobsforgood.mjs')).href)).default;

  if (techjobsforgood.id === 'techjobsforgood') pass('techjobsforgood.id is "techjobsforgood"');
  else fail(`techjobsforgood.id is ${JSON.stringify(techjobsforgood.id)}`);

  // ── detect() ───────────────────────────────────────────────────────────────
  {
    const positives = [
      [{ name: 'X', careers_url: 'https://techjobsforgood.com/jobs/' }, 'the board landing URL'],
      [{ name: 'X', careers_url: 'https://www.techjobsforgood.com/' }, 'the www host'],
      [{ name: 'X', careers_url: 'https://techjobsforgood.com/jobs/?page=2' }, 'a paginated URL (the filter is never inherited)'],
      [{ name: 'X', api: 'https://techjobsforgood.com/jobs/' }, 'an `api` field on the board host'],
      [{ name: 'X', provider: 'techjobsforgood' }, 'an explicit provider with no URL at all'],
    ];
    let hits = 0;
    for (const [entry, label] of positives) {
      const hit = techjobsforgood.detect(entry);
      if (hit && hit.url === INDEX_URL) hits++;
      else fail(`techjobsforgood.detect() should claim ${label} — got ${JSON.stringify(hit)}`);
    }
    if (hits === positives.length) pass(`techjobsforgood.detect() claims ${positives.length} valid board entries`);

    const misses = [
      [null, 'null entry'],
      [{}, 'empty entry'],
      [{ name: 'X', careers_url: 'https://techjobsforgood.com.evil.example/jobs/' }, 'a look-alike host'],
      [{ name: 'X', careers_url: 'https://evil.example/jobs/?next=techjobsforgood.com' }, 'an untrusted host'],
      [{ name: 'X', careers_url: 'http://techjobsforgood.com/jobs/' }, 'a non-HTTPS URL'],
      [{ name: 'X', careers_url: 'not a url' }, 'a malformed URL'],
      [{ name: 'X', careers_url: 42 }, 'a non-string careers_url'],
      ['nope', 'a non-object entry'],
    ];
    let missesHit = 0;
    for (const [entry, label] of misses) {
      let out;
      try {
        out = techjobsforgood.detect(entry);
      } catch (e) {
        fail(`techjobsforgood.detect() threw on ${label}: ${e.message}`);
        out = 'threw';
      }
      if (out === null) missesHit++;
      else fail(`techjobsforgood.detect() should return null for ${label} — got ${JSON.stringify(out)}`);
    }
    if (missesHit === misses.length) pass(`techjobsforgood.detect() returns null for ${misses.length} non-matching entries`);
  }

  // ── fetch() normalization: index walk + per-card JSON-LD ──────────────────
  {
    const ctx = makeCtx({
      [pageUrl(1)]: INDEX_HTML,
      [cardUrl('36001')]: CARD_HTML,
      [cardUrl('36002')]: EXPIRED_HTML,
    });
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let jobs;
    try {
      jobs = await techjobsforgood.fetch(ENTRY, ctx);
    } finally {
      console.error = realError;
    }

    if (ctx.calls.length === 3) pass('techjobsforgood.fetch() makes one index request + one request per card');
    else fail(`techjobsforgood.fetch() made ${ctx.calls.length} requests: ${ctx.calls.map(c => c.url).join(', ')}`);

    if (ctx.calls.every((c) => c.opts?.redirect === 'error')) {
      pass('techjobsforgood.fetch() passes redirect:"error" on every request');
    } else {
      fail(`techjobsforgood.fetch() redirect opts: ${JSON.stringify(ctx.calls.map(c => c.opts))}`);
    }

    // The expired card (200 shell, no JobPosting block) is skipped, not emitted.
    if (jobs.length === 1) pass('techjobsforgood.fetch() skips a card with no JobPosting block');
    else fail(`techjobsforgood.fetch() returned ${jobs.length} jobs, expected 1`);
    if (warnings.some((w) => /1 with no JobPosting block/.test(w))) {
      pass('techjobsforgood.fetch() counts the skipped expired card');
    } else {
      fail(`techjobsforgood.fetch() did not report the skip — warnings: ${JSON.stringify(warnings)}`);
    }

    const job = jobs[0] || {};
    if (job.title === 'Programs Director' && job.company === 'Acme Nonprofit') {
      pass('techjobsforgood.fetch() maps title / employer from the JSON-LD');
    } else {
      fail(`techjobsforgood.fetch() first row = ${JSON.stringify(job)}`);
    }

    // The employer's ATS URL is the canonical identity (rule 2), and the
    // board's own referral tag is stripped so it matches the plain employer URL.
    if (job.url === 'https://ats.example.org/acme/jobs/123') {
      pass('techjobsforgood.fetch() keys job.url on the employer apply URL with the referral tag stripped');
    } else {
      fail(`techjobsforgood.fetch() url = ${JSON.stringify(job.url)}`);
    }

    if (job.location === 'Remote (US)') pass('techjobsforgood.fetch() prefers the index location when the JSON-LD is country-only');
    else fail(`techjobsforgood.fetch() location = ${JSON.stringify(job.location)}`);

    if (job.description?.includes('Build & ship accessible tools')) {
      pass('techjobsforgood.fetch() decodes HTML entities in the flattened JD');
    } else {
      fail(`techjobsforgood.fetch() description = ${JSON.stringify(job.description)}`);
    }

    if (job.description?.includes('Source: https://techjobsforgood.com/jobs/36001/')) {
      pass('techjobsforgood.fetch() attributes the board card URL in the description');
    } else {
      fail(`techjobsforgood.fetch() description missing the board attribution: ${JSON.stringify(job.description)}`);
    }

    if (job.postedAt === Date.parse('2026-10-01')) pass('techjobsforgood.fetch() reads datePosted');
    else fail(`techjobsforgood.fetch() postedAt = ${JSON.stringify(job.postedAt)}`);

    if (job.salary?.min === 90000 && job.salary?.max === 110000 && job.salary?.currency === 'USD') {
      pass('techjobsforgood.fetch() reads an annual salary range');
    } else {
      fail(`techjobsforgood.fetch() salary = ${JSON.stringify(job.salary)}`);
    }

    if (job.externalId === '36001') pass('techjobsforgood.fetch() sets externalId from the posting id');
    else fail(`techjobsforgood.fetch() externalId = ${JSON.stringify(job.externalId)}`);
  }

  // ── job.url fallback + hourly salary is left off ──────────────────────────
  {
    const ctx = makeCtx({
      [pageUrl(1)]: indexPage(['36010', '36011']),
      [cardUrl('36010')]: cardHtml('36010', { applyUrl: '', unitText: 'HOUR' }),
      [cardUrl('36011')]: cardHtml('36011', { applyUrl: 'http://insecure.example.org/jobs/9' }),
    });
    const jobs = await techjobsforgood.fetch(ENTRY, ctx);

    if (jobs[0]?.url === cardUrl('36010')) pass('techjobsforgood.fetch() falls back to the board card URL when no apply URL exists');
    else fail(`techjobsforgood.fetch() fallback url = ${JSON.stringify(jobs[0]?.url)}`);

    if (jobs[0]?.salary === undefined) pass('techjobsforgood.fetch() leaves an hourly rate off rather than annualizing it');
    else fail(`techjobsforgood.fetch() hourly salary = ${JSON.stringify(jobs[0]?.salary)}`);

    // A plain-http apply link is not taken: it would downgrade the user's session.
    if (jobs[1]?.url === cardUrl('36011')) pass('techjobsforgood.fetch() refuses a non-HTTPS apply URL');
    else fail(`techjobsforgood.fetch() non-https apply url = ${JSON.stringify(jobs[1]?.url)}`);
  }

  // ── Empty vs broken ────────────────────────────────────────────────────────
  {
    const empty = await techjobsforgood.fetch(ENTRY, makeCtx({
      [pageUrl(1)]: '<div class="ui container"><p>0 jobs found</p></div>',
    }));
    if (Array.isArray(empty) && empty.length === 0) {
      pass('techjobsforgood.fetch() returns [] for a genuinely empty index');
    } else {
      fail(`techjobsforgood.fetch() empty index = ${JSON.stringify(empty)}`);
    }

    const broken = [
      [indexPage([]).replace('<p>0 jobs found</p>', '<p>101 jobs found</p>'), 'a stated count with no cards'],
      // Card markup present (the listing signal) but no parseable id.
      ['<div class="ui raised fluid card job-card"><a href="/nothing/">x</a></div><p>1 jobs found</p>', 'card markup with no posting id'],
    ];
    let threw = 0;
    for (const [html, label] of broken) {
      try {
        await techjobsforgood.fetch(ENTRY, makeCtx({ [pageUrl(1)]: html }));
        fail(`techjobsforgood.fetch() should throw on ${label}`);
      } catch (e) {
        if (/markup changed/.test(e.message)) threw++;
        else fail(`techjobsforgood.fetch() threw an unhelpful error on ${label}: ${e.message}`);
      }
    }
    if (threw === broken.length) pass(`techjobsforgood.fetch() throws a descriptive error on ${broken.length} broken index shapes`);
  }

  // ── Every card missing its JSON-LD is a markup change ─────────────────────
  {
    let threw = false;
    try {
      await techjobsforgood.fetch(ENTRY, makeCtx({
        [pageUrl(1)]: indexPage(['36020']),
        [cardUrl('36020')]: EXPIRED_HTML,
      }));
    } catch (e) {
      threw = /card markup changed/.test(e.message);
    }
    if (threw) pass('techjobsforgood.fetch() throws when every card lacks a JobPosting block');
    else fail('techjobsforgood.fetch() must throw when no card yields a record');
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  {
    const p1 = Array.from({ length: 30 }, (_, i) => String(37000 + i));
    const p2 = Array.from({ length: 30 }, (_, i) => String(37030 + i));
    const p3 = Array.from({ length: 11 }, (_, i) => String(37060 + i));
    const all = [...p1, ...p2, ...p3];
    const ctx = makeCtx({
      [pageUrl(1)]: indexPage(p1),
      [pageUrl(2)]: indexPage(p2),
      [pageUrl(3)]: indexPage(p3),
      ...cardRoutes(all),
    });
    const jobs = await techjobsforgood.fetch(ENTRY, ctx);
    const indexCalls = ctx.calls.filter((c) => c.url.startsWith(PAGE_PREFIX));
    if (indexCalls.length === 3 && jobs.length === 71) {
      pass('techjobsforgood.fetch() walks the index until a short page (30/30/11)');
    } else {
      fail(`techjobsforgood.fetch() pagination: ${indexCalls.length} index requests, ${jobs.length} jobs`);
    }
  }

  {
    // The provider's own DEFAULT_MAX_PAGES (20) stops the walk even when the
    // source keeps returning full pages, and says so.
    const pages = Array.from({ length: 20 }, (_, p) => Array.from({ length: 30 }, (_, i) => String(38000 + p * 30 + i)));
    const routes = {};
    pages.forEach((ids, p) => { routes[pageUrl(p + 1)] = indexPage(ids); });
    Object.assign(routes, cardRoutes(pages.flat()));
    const ctx = makeCtx(routes);
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let jobs;
    try {
      jobs = await techjobsforgood.fetch(ENTRY, ctx);
    } finally {
      console.error = realError;
    }
    const indexCalls = ctx.calls.filter((c) => c.url.startsWith(PAGE_PREFIX));
    if (indexCalls.length === 20 && jobs.length === 600) pass('techjobsforgood.fetch() stops at its own DEFAULT_MAX_PAGES (20)');
    else fail(`techjobsforgood.fetch() default cap: ${indexCalls.length} index requests, ${jobs.length} jobs`);
    if (warnings.some((w) => /raise max_pages/.test(w))) pass('techjobsforgood.fetch() warns when max_pages truncated a full page');
    else fail(`techjobsforgood.fetch() did not warn on a cap stop — warnings: ${JSON.stringify(warnings)}`);

    // An entry-level max_pages lowers the walk.
    const smallCtx = makeCtx({
      [pageUrl(1)]: indexPage(pages[0]),
      [pageUrl(2)]: indexPage(pages[1]),
      ...cardRoutes([...pages[0], ...pages[1]]),
    });
    const smallJobs = await techjobsforgood.fetch({ ...ENTRY, max_pages: 2 }, smallCtx);
    const smallIndexCalls = smallCtx.calls.filter((c) => c.url.startsWith(PAGE_PREFIX));
    if (smallIndexCalls.length === 2 && smallJobs.length === 60) pass('techjobsforgood.fetch() honours entry.max_pages');
    else fail(`techjobsforgood.fetch() entry.max_pages: ${smallIndexCalls.length} index requests, ${smallJobs.length} jobs`);
  }

  // ── Probe cooperation (ctx.maxPages) ──────────────────────────────────────
  {
    const ctx = makeCtx({ [pageUrl(1)]: INDEX_HTML });
    const jobs = await techjobsforgood.fetch(ENTRY, { ...ctx, maxPages: 1 });
    if (ctx.calls.length === 1 && jobs.length === 2) {
      pass('techjobsforgood.fetch() makes exactly one request under ctx.maxPages: 1 and skips the card walk');
    } else {
      fail(`techjobsforgood.fetch() probe: ${ctx.calls.length} requests, ${jobs.length} jobs`);
    }
    if (jobs[0]?.url === cardUrl('36001') && jobs[0]?.title === 'Programs Director') {
      pass('techjobsforgood.fetch() builds probe jobs from the index cards');
    } else {
      fail(`techjobsforgood.fetch() probe row = ${JSON.stringify(jobs[0])}`);
    }

    // A fetch rejection while probing must arrive unwrapped — verify-portals
    // identifies its own request-budget error by identity.
    class ProbePageBudgetReached extends Error {}
    const budgetErr = new ProbePageBudgetReached('probe budget');
    let propagated = null;
    try {
      await techjobsforgood.fetch(ENTRY, {
        ...makeCtx({}),
        maxPages: 1,
        fetchText: async () => { throw budgetErr; },
      });
    } catch (e) {
      propagated = e;
    }
    if (propagated === budgetErr) pass('techjobsforgood.fetch() propagates a probe-budget rejection unwrapped');
    else fail(`techjobsforgood.fetch() probe rejection was rewrapped: ${propagated?.message}`);
  }

  // ── Pagination + transient failure ────────────────────────────────────────
  {
    // A 404 past the last page is the board's natural end: keep page 1, no
    // "raise max_pages" warning (that message means a healthy board was cut).
    const ids = Array.from({ length: 30 }, (_, i) => String(39000 + i));
    const notFound = new Error('HTTP 404 Not Found');
    notFound.status = 404;
    const ctx = makeCtx({ [pageUrl(1)]: indexPage(ids), [pageUrl(2)]: notFound, ...cardRoutes(ids) });
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let jobs;
    try {
      jobs = await techjobsforgood.fetch(ENTRY, ctx);
    } finally {
      console.error = realError;
    }
    const indexCalls = ctx.calls.filter((c) => c.url.startsWith(PAGE_PREFIX));
    if (indexCalls.length === 2 && jobs.length === 30) pass('techjobsforgood.fetch() treats a 404 past the last page as a natural end');
    else fail(`techjobsforgood.fetch() 404 stop: ${indexCalls.length} index requests, ${jobs.length} jobs`);
    if (!warnings.some((w) => /raise max_pages/.test(w))) {
      pass('techjobsforgood.fetch() does not fire the max_pages warning on a 404 stop');
    } else {
      fail(`techjobsforgood.fetch() wrong warnings on a 404 stop: ${JSON.stringify(warnings)}`);
    }
  }

  {
    // A 429 / 5xx on page 2 that retry cannot clear: keep page 1 and warn, and
    // do NOT fire the "raise max_pages" warning.
    const ids = Array.from({ length: 30 }, (_, i) => String(39100 + i));
    const serverError = new Error('HTTP 503 Service Unavailable');
    serverError.status = 503;
    const ctx = makeCtx({ [pageUrl(1)]: indexPage(ids), [pageUrl(2)]: serverError, ...cardRoutes(ids) });
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let jobs;
    try {
      jobs = await techjobsforgood.fetch(ENTRY, ctx);
    } catch (e) {
      jobs = `threw: ${e.message}`;
    } finally {
      console.error = realError;
    }
    if (Array.isArray(jobs) && jobs.length === 30) pass('techjobsforgood.fetch() keeps pages 1..N when retry exhausts on a 5xx');
    else fail(`techjobsforgood.fetch() 5xx exhaustion = ${JSON.stringify(jobs).slice(0, 120)}`);
    if (warnings.length > 0 && !warnings.some((w) => /raise max_pages/.test(w))) {
      pass('techjobsforgood.fetch() does not fire the max_pages warning on a fetch-error stop');
    } else {
      fail(`techjobsforgood.fetch() wrong warnings on a fetch-error stop: ${JSON.stringify(warnings)}`);
    }
  }

  // ── A single card fetch failure is skipped, not fatal ─────────────────────
  {
    const ctx = makeCtx({
      [pageUrl(1)]: indexPage(['39200', '39201']),
      [cardUrl('39200')]: cardHtml('39200'),
      [cardUrl('39201')]: new Error('HTTP 500 Internal Server Error'),
    });
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let jobs;
    try {
      jobs = await techjobsforgood.fetch(ENTRY, ctx);
    } finally {
      console.error = realError;
    }
    if (Array.isArray(jobs) && jobs.length === 1 && jobs[0].externalId === '39200') {
      pass('techjobsforgood.fetch() skips a failed card fetch and keeps the rest');
    } else {
      fail(`techjobsforgood.fetch() failed-card handling = ${JSON.stringify(jobs).slice(0, 160)}`);
    }
    if (warnings.some((w) => /1 fetch failure/.test(w))) pass('techjobsforgood.fetch() counts the failed card fetch');
    else fail(`techjobsforgood.fetch() did not report the fetch failure — warnings: ${JSON.stringify(warnings)}`);
  }
} catch (e) {
  fail(`techjobsforgood provider tests crashed: ${e.message}`);
}
