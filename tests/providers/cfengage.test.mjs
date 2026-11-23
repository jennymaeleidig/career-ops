// tests/providers/cfengage.test.mjs — direct provider-contract tests.
// CFengage is a HandsOn Connect board whose whole inventory arrives in one
// anonymous JSON POST, so the tests are about the mapping of that envelope
// (`records[].Columns[]`), the empty-vs-broken split on it, and the page walk's
// cooperation with ctx.maxPages while a health probe runs.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nProvider — cfengage');

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'cfengage-listing.json'), 'utf-8'));

const ENTRY = {
  name: 'CFengage (Greater Richmond nonprofit jobs)',
  provider: 'cfengage',
  careers_url: 'https://www.cfengage.org/Jobs',
  cfengage: { block_id: 71734, view_id: '00B5c000006PDKzEAO', listing_cms_id: 6355 },
};

// A ctx stub: no wall-clock waiting, no network. `responses` is consumed one
// entry per request; a function entry is called with (url, opts).
function makeCtx(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    transport: 'http',
    sleep: async () => {},
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      const next = responses[Math.min(index, responses.length - 1)];
      index++;
      return typeof next === 'function' ? next(url, opts) : next;
    },
  };
}

// N rows of a well-formed payload, so a page can be made "full" or "short".
const rows = (n, offset = 0) => ({
  status: 'ok',
  records: Array.from({ length: n }, (_, i) => ({
    Columns: [
      { FieldNameOrPath: 'Job_Title__c', Value: `Role ${offset + i}` },
      { FieldNameOrPath: 'Posting_Organization__r.Name', Value: 'Acme Nonprofit' },
      { FieldNameOrPath: 'Location__c', Value: 'Richmond, VA' },
      { FieldNameOrPath: 'Job_Posting_Slug__c', Value: `Role-${offset + i}` },
      { FieldNameOrPath: 'Id', Value: `a23Nw00000${String(offset + i).padStart(5, '0')}` },
    ],
  })),
});

try {
  const cfengage = (await import(pathToFileURL(join(ROOT, 'providers/cfengage.mjs')).href)).default;

  if (cfengage.id === 'cfengage') pass('cfengage.id is "cfengage"');
  else fail(`cfengage.id is ${JSON.stringify(cfengage.id)}`);

  // ── detect() — explicit-only ────────────────────────────────────────────────
  const hit = cfengage.detect({ ...ENTRY, careers_url: undefined, cfengage: undefined });
  if (hit && hit.url === 'https://www.cfengage.org/admin/GetSalesforceViewRecords') {
    pass('cfengage.detect() claims an entry with provider: cfengage, with no careers_url/api');
  } else {
    fail(`cfengage.detect() returned ${JSON.stringify(hit)}`);
  }
  const missCases = [
    [null, 'null entry'],
    [{}, 'empty entry'],
    [{ name: 'X', careers_url: 'https://www.cfengage.org/Jobs' }, 'board URL but no provider'],
    [{ name: 'X', provider: 'consider', careers_url: 'https://www.cfengage.org/Jobs' }, 'another provider'],
    ['nope', 'non-object entry'],
  ];
  let misses = 0;
  for (const [entry, label] of missCases) {
    let out;
    try {
      out = cfengage.detect(entry);
    } catch (e) {
      fail(`cfengage.detect() threw on ${label}: ${e.message}`);
      out = 'threw';
    }
    if (out === null) misses++;
    else fail(`cfengage.detect() should return null for ${label} — got ${JSON.stringify(out)}`);
  }
  if (misses === missCases.length) pass(`cfengage.detect() returns null for ${missCases.length} non-matching entries`);

  // ── fetch() normalization ──────────────────────────────────────────────────
  {
    const ctx = makeCtx([FIXTURE]);
    const jobs = await cfengage.fetch(ENTRY, ctx);

    if (ctx.calls[0]?.opts?.redirect === 'error') pass('cfengage.fetch() passes redirect:"error"');
    else fail(`cfengage.fetch() redirect = ${JSON.stringify(ctx.calls[0]?.opts)}`);

    if (ctx.calls[0]?.url === 'https://www.cfengage.org/admin/GetSalesforceViewRecords'
      && ctx.calls[0]?.opts?.method === 'POST') {
      pass('cfengage.fetch() POSTs the board route');
    } else {
      fail(`cfengage.fetch() request = ${JSON.stringify(ctx.calls[0])}`);
    }

    const body = new URLSearchParams(String(ctx.calls[0]?.opts?.body || ''));
    if (body.get('blockId') === '71734'
      && body.get('Sfview') === '00B5c000006PDKzEAO'
      && body.get('listingCmsId') === '6355'
      && body.get('formatToDisplay') === 'GRID'
      && body.get('offset') === '0') {
      pass('cfengage.fetch() sends the entry tenant ids and the first offset');
    } else {
      fail(`cfengage.fetch() body = ${String(ctx.calls[0]?.opts?.body)}`);
    }

    // The malformed third record has no title and is dropped, not fatal.
    if (jobs.length === 2) pass('cfengage.fetch() drops a record with no title and keeps the rest');
    else fail(`cfengage.fetch() returned ${jobs.length} jobs, expected 2`);

    const first = jobs[0] || {};
    if (first.title === 'Programs Director' && first.company === 'Acme Nonprofit' && first.location === 'Richmond, VA') {
      pass('cfengage.fetch() maps title / employer / location');
    } else {
      fail(`cfengage.fetch() first row = ${JSON.stringify(first)}`);
    }

    // The board's own per-posting page is the dedup key: unique per record,
    // while the employer apply URL is shared by sibling postings.
    if (first.url === 'https://www.cfengage.org/job-posting-connector/p/a23Nw000005L2LhIAK/Programs-Director') {
      pass('cfengage.fetch() keys job.url on the board detail page');
    } else {
      fail(`cfengage.fetch() url = ${JSON.stringify(first.url)}`);
    }

    if (first.description?.includes('community & school')) {
      pass('cfengage.fetch() decodes HTML entities in the flattened JD');
    } else {
      fail(`cfengage.fetch() description = ${JSON.stringify(first.description)}`);
    }

    if (first.description?.includes('Apply: https://acme.example.org/careers/programs-director')) {
      pass('cfengage.fetch() carries the employer apply URL in the description');
    } else {
      fail(`cfengage.fetch() description missing the apply link: ${JSON.stringify(first.description)}`);
    }

    // The date comes from the RAW field, never its `,"M/d/yyyy"` twin.
    if (first.postedAt === Date.parse('Mon Oct 26 00:00:00 GMT 2026')) {
      pass('cfengage.fetch() reads the raw Approval_Date__c, ignoring the formatted variant');
    } else {
      fail(`cfengage.fetch() postedAt = ${JSON.stringify(first.postedAt)} (${new Date(first.postedAt).toISOString?.()})`);
    }

    if (first.externalId === 'a23Nw000005L2LhIAK') pass('cfengage.fetch() sets externalId from the record Id');
    else fail(`cfengage.fetch() externalId = ${JSON.stringify(first.externalId)}`);

    if (first.salary?.min === 65000 && first.salary?.max === 100000) {
      pass('cfengage.fetch() parses an annual salary range');
    } else {
      fail(`cfengage.fetch() salary = ${JSON.stringify(first.salary)}`);
    }

    // An hourly rate is left off rather than annualized on an assumption.
    const second = jobs[1] || {};
    if (second.salary === undefined && second.postedAt === Date.parse('Thu Oct 15 00:00:00 GMT 2026')) {
      pass('cfengage.fetch() leaves an hourly salary off and keeps the posted date');
    } else {
      fail(`cfengage.fetch() second row = ${JSON.stringify(second)}`);
    }
  }

  // ── Empty vs broken ────────────────────────────────────────────────────────
  {
    const empty = await cfengage.fetch(ENTRY, makeCtx([{ status: 'ok', records: [] }]));
    if (Array.isArray(empty) && empty.length === 0) pass('cfengage.fetch() returns [] for a present-but-empty records[]');
    else fail(`cfengage.fetch() empty payload = ${JSON.stringify(empty)}`);

    const broken = [
      [{}, 'bare {}'],
      ['', 'contentless body'],
      [{ status: 'ok', records: null }, 'records: null'],
      [{ status: 'ok', jobs: [] }, 'a different container key'],
      [{ status: 'ok', records: {} }, 'records: {}'],
    ];
    let threw = 0;
    for (const [payload, label] of broken) {
      try {
        await cfengage.fetch(ENTRY, makeCtx([payload]));
        fail(`cfengage.fetch() should throw on ${label}`);
      } catch (e) {
        if (/expected records\[\]/.test(e.message)) threw++;
        else fail(`cfengage.fetch() threw an unhelpful error on ${label}: ${e.message}`);
      }
    }
    if (threw === broken.length) pass(`cfengage.fetch() throws a descriptive error on ${broken.length} broken envelopes`);
  }

  // ── Config guard ───────────────────────────────────────────────────────────
  {
    let threw = false;
    try {
      await cfengage.fetch({ name: 'No ids', provider: 'cfengage' }, makeCtx([rows(1)]));
    } catch (e) {
      threw = /block_id/.test(e.message);
    }
    if (threw) pass('cfengage.fetch() throws on an entry with no tenant ids');
    else fail('cfengage.fetch() must require cfengage.block_id / view_id / listing_cms_id');
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  {
    // A full page follows a full page: the walk continues until the short one.
    const ctx = makeCtx([rows(100, 0), rows(100, 100), rows(5, 200)]);
    const jobs = await cfengage.fetch(ENTRY, ctx);
    if (ctx.calls.length === 3 && jobs.length === 205) pass('cfengage.fetch() walks pages until a short page');
    else fail(`cfengage.fetch() pagination: ${ctx.calls.length} requests, ${jobs.length} jobs`);

    const offsets = ctx.calls.map(c => new URLSearchParams(String(c.opts.body)).get('offset'));
    if (offsets.join(',') === '0,100,200') pass('cfengage.fetch() advances offset by the page size');
    else fail(`cfengage.fetch() offsets = ${JSON.stringify(offsets)}`);
  }

  {
    // The provider's own DEFAULT_MAX_PAGES (5) stops the walk even when the
    // source keeps returning full pages, and says so.
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let ctx;
    let jobs;
    try {
      ctx = makeCtx([rows(100, 0), rows(100, 100), rows(100, 200), rows(100, 300), rows(100, 400), rows(100, 500)]);
      jobs = await cfengage.fetch(ENTRY, ctx);
    } finally {
      console.error = realError;
    }
    if (ctx.calls.length === 5 && jobs.length === 500) pass('cfengage.fetch() stops at its own DEFAULT_MAX_PAGES (5)');
    else fail(`cfengage.fetch() default cap: ${ctx.calls.length} requests, ${jobs.length} jobs`);
    if (warnings.some(w => /raise max_pages/.test(w))) pass('cfengage.fetch() warns when max_pages truncated a full page');
    else fail(`cfengage.fetch() did not warn on a cap stop — warnings: ${JSON.stringify(warnings)}`);

    // An entry-level max_pages lowers the walk.
    const small = makeCtx([rows(100, 0), rows(100, 100), rows(100, 200)]);
    const smallJobs = await cfengage.fetch({ ...ENTRY, max_pages: 2 }, small);
    if (small.calls.length === 2 && smallJobs.length === 200) pass('cfengage.fetch() honours entry.max_pages');
    else fail(`cfengage.fetch() entry.max_pages: ${small.calls.length} requests, ${smallJobs.length} jobs`);
  }

  // ── Probe cooperation (ctx.maxPages) ──────────────────────────────────────
  {
    const ctx = makeCtx([rows(100, 0), rows(100, 100), rows(100, 200)]);
    const jobs = await cfengage.fetch(ENTRY, { ...ctx, maxPages: 1 });
    if (ctx.calls.length === 1 && jobs.length === 100) pass('cfengage.fetch() makes exactly one request under ctx.maxPages: 1');
    else fail(`cfengage.fetch() probe: ${ctx.calls.length} requests, ${jobs.length} jobs`);

    // A fetch rejection while probing must arrive unwrapped — verify-portals
    // identifies its own request-budget error by identity.
    class ProbePageBudgetReached extends Error {}
    const budgetErr = new ProbePageBudgetReached('probe budget');
    let propagated = null;
    try {
      await cfengage.fetch(ENTRY, {
        ...makeCtx([]),
        maxPages: 1,
        fetchJson: async () => { throw budgetErr; },
        sleep: async () => {},
      });
    } catch (e) {
      propagated = e;
    }
    if (propagated === budgetErr) pass('cfengage.fetch() propagates a probe-budget rejection unwrapped');
    else fail(`cfengage.fetch() probe rejection was rewrapped: ${propagated?.message}`);
  }

  // ── Pagination + transient failure ────────────────────────────────────────
  {
    // A page-2 payload that is no longer the documented envelope is a shape
    // change, not an empty board: it fails loud rather than handing back a
    // silently short list.
    let threw = false;
    try {
      await cfengage.fetch(ENTRY, makeCtx([rows(100, 0), { status: 'error' }]));
    } catch (e) {
      threw = /expected records\[\]/.test(e.message);
    }
    if (threw) pass('cfengage.fetch() fails loud on a mid-walk envelope change');
    else fail('cfengage.fetch() must throw when a later page loses its records[] envelope');
  }

  {
    // A 429 on page 2 that retry cannot clear: keep page 1 and warn, and do NOT
    // fire the "raise max_pages" warning (that message means a healthy board
    // was truncated, not that it broke).
    const realError = console.error;
    const warnings = [];
    console.error = (msg) => warnings.push(String(msg));
    let jobs;
    try {
      jobs = await cfengage.fetch(ENTRY, {
        ...makeCtx([]),
        sleep: async () => {},
        fetchJson: async (url, opts) => {
          const offset = new URLSearchParams(String(opts.body)).get('offset');
          if (offset === '0') return rows(100, 0);
          const err = new Error('HTTP 429 Too Many Requests');
          err.status = 429;
          throw err;
        },
      });
    } catch (e) {
      jobs = `threw: ${e.message}`;
    } finally {
      console.error = realError;
    }
    if (Array.isArray(jobs) && jobs.length === 100) pass('cfengage.fetch() keeps pages 1..N when retry exhausts on a 429');
    else fail(`cfengage.fetch() 429 exhaustion = ${JSON.stringify(jobs).slice(0, 120)}`);
    if (warnings.length > 0 && !warnings.some(w => /raise max_pages/.test(w))) {
      pass('cfengage.fetch() does not fire the max_pages warning on a fetch-error stop');
    } else {
      fail(`cfengage.fetch() wrong warnings on a fetch-error stop: ${JSON.stringify(warnings)}`);
    }
  }
} catch (e) {
  fail(`cfengage provider tests crashed: ${e.message}`);
}
