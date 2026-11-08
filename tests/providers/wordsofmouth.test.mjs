// tests/providers/wordsofmouth.test.mjs — direct provider-contract tests.
//
// Words of Mouth is a scraped, three-platform newsletter: the archive index
// yields issue links (host-allowlisted, because the URL comes from page data)
// and each issue page yields label-delimited listing blocks. The tests below
// pin the four things that can silently rot: the host guard, the bounded walk,
// the label parser, and the broken-vs-empty split.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { readFileSync } from 'fs';

console.log('\nProvider — wordsofmouth');

const fixture = (name) => readFileSync(join(ROOT, 'tests', 'fixtures', name), 'utf8');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/wordsofmouth.mjs')).href);
  const provider = mod.default;
  const { parseIndexPage, parseIssuePage, normalizeIssueHref, parseIssueDate, resolveRecentIssues } = mod;

  if (provider.id === 'wordsofmouth') pass('wordsofmouth.id is "wordsofmouth"');
  else fail(`wordsofmouth.id is ${JSON.stringify(provider.id)}`);

  // --- detect(): explicit-only ------------------------------------------------
  // The source is a single newsletter; only an explicit `provider:` claims it,
  // so a user's unrelated board is never silently routed here.
  const hit = provider.detect({ name: 'Words of Mouth', provider: 'wordsofmouth' });
  if (hit?.url === 'https://www.wordsofmouth.org/archive') pass('wordsofmouth.detect() claims an explicit provider entry');
  else fail(`wordsofmouth.detect() returned ${JSON.stringify(hit)}`);

  let detectOk = 0;
  for (const junk of [undefined, null, {}, { name: 'X' }, { provider: 'greenhouse' }, 'wordsofmouth', 42]) {
    if (provider.detect(/** @type {any} */ (junk)) === null) detectOk++;
    else fail(`wordsofmouth.detect() should return null for ${JSON.stringify(junk)}`);
  }
  if (detectOk === 7) pass('wordsofmouth.detect() returns null for anything else (7 shapes, no throw)');

  // --- host guard on scraped issue URLs (SSRF) -------------------------------
  const GUARD_CASES = [
    ['https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme', 'https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme'],
    // The archive emits a doubled scheme live (observed 2026-10-27).
    ['https://  https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme', 'https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme'],
    // http from the 2016-17 era is upgraded, never downgraded.
    ['http://mailchi.mp/wordsofmouth/words-of-mouth-acme', 'https://mailchi.mp/wordsofmouth/words-of-mouth-acme'],
    ['https://us12.campaign-archive2.com/?u=abc&id=def', 'https://us12.campaign-archive2.com/?u=abc&id=def'],
  ];
  let guardHits = 0;
  for (const [input, expected] of GUARD_CASES) {
    const got = normalizeIssueHref(input);
    if (got === expected) guardHits++;
    else fail(`normalizeIssueHref(${input}) = ${JSON.stringify(got)}, expected ${expected}`);
  }
  if (guardHits === GUARD_CASES.length) pass(`normalizeIssueHref() resolves ${guardHits} allowlisted shapes (incl. doubled scheme, http upgrade)`);

  const GUARD_BLOCKED = [
    'https://evil.example.com/p/words-of-mouth-acme',
    'https://wordsofmouth.beehiiv.com.evil.example.com/p/x',
    'https://evilwordsofmouth.beehiiv.com/p/x',
    'https://us12.campaign-archive2.com.evil.example/?u=x',
    'javascript:alert(1)',
    'ftp://wordsofmouth.beehiiv.com/p/x',
    '/archive-2016',
    'not a url',
    '',
    null,
    undefined,
  ];
  let blocked = 0;
  for (const input of GUARD_BLOCKED) {
    if (normalizeIssueHref(/** @type {any} */ (input)) === null) blocked++;
    else fail(`normalizeIssueHref() must reject ${JSON.stringify(input)}, got ${JSON.stringify(normalizeIssueHref(/** @type {any} */ (input)))}`);
  }
  if (blocked === GUARD_BLOCKED.length) pass(`normalizeIssueHref() rejects ${blocked} off-host / non-http / malformed values`);

  // --- date label ------------------------------------------------------------
  if (parseIssueDate('Week of 10/26/26') === Date.UTC(2026, 9, 26)) pass('parseIssueDate() reads "Week of M/D/YY"');
  else fail(`parseIssueDate('Week of 10/26/26') = ${parseIssueDate('Week of 10/26/26')}`);

  if (parseIssueDate('1/17/25: Hire an Angeleno!') === Date.UTC(2025, 0, 17)) pass('parseIssueDate() reads a labelled special issue');
  else fail(`parseIssueDate special issue = ${parseIssueDate('1/17/25: Hire an Angeleno!')}`);

  let undated = 0;
  for (const label of ['', 'Week of 8/', '13/40/26', 'Week of 44/9/26']) {
    if (parseIssueDate(label) === undefined) undated++;
    else fail(`parseIssueDate(${JSON.stringify(label)}) must be undefined, got ${parseIssueDate(label)}`);
  }
  if (undated === 4) pass('parseIssueDate() leaves an unreadable label undated instead of inventing one');

  // --- archive index ---------------------------------------------------------
  const issues = parseIndexPage(fixture('wordsofmouth-archive.html'));
  if (issues.length === 4) pass('parseIndexPage() keeps 4 allowlisted issues from the trimmed archive');
  else fail(`parseIndexPage() returned ${issues.length} issues: ${JSON.stringify(issues)}`);

  if (issues[0].url === 'https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme-museum-example-trust'
    && issues[0].postedAt === Date.UTC(2026, 9, 26)) {
    pass('parseIndexPage() keeps DOM order (newest first) and reads the issue date');
  } else {
    fail(`parseIndexPage() first issue = ${JSON.stringify(issues[0])}`);
  }

  if (issues.filter((i) => i.url.includes('words-of-mouth-bigco-design')).length === 1) {
    pass('parseIndexPage() collapses the same issue linked twice with tracking params');
  } else {
    fail('parseIndexPage() should de-duplicate by host + path');
  }

  if (issues.every((i) => i.url.startsWith('https://'))) pass('parseIndexPage() emits only https issue URLs');
  else fail('parseIndexPage() emitted a non-https issue URL');

  // --- issue parsing ---------------------------------------------------------
  const issueJobs = parseIssuePage(fixture('wordsofmouth-issue.html'), {
    issueUrl: 'https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme',
    postedAt: Date.UTC(2026, 9, 26),
  });
  if (issueJobs.length === 3) pass('parseIssuePage() parses 3 Jobs-section listings and skips the Classifieds ad');
  else fail(`parseIssuePage() returned ${issueJobs.length}: ${JSON.stringify(issueJobs, null, 2)}`);

  const artDirector = issueJobs[0];
  if (artDirector?.title === 'Art Director'
    && artDirector.company === 'Acme Studio'
    && artDirector.location === 'Remote'
    && artDirector.url === 'https://boards.example.com/acme/art-director'
    && artDirector.postedAt === Date.UTC(2026, 9, 26)) {
    pass('parseIssuePage() fills title / company / location / employer URL / issue date');
  } else {
    fail(`parseIssuePage() first row = ${JSON.stringify(artDirector)}`);
  }

  // Entities are decoded before the value is used, not just somewhere in the file.
  if (issueJobs[1]?.title === 'Operations Manager, Prints & Editions') {
    pass('parseIssuePage() decodes &amp; in the title');
  } else {
    fail(`parseIssuePage() entity title = ${JSON.stringify(issueJobs[1]?.title)}`);
  }

  // Rule 2: a mailto: `What:` link falls back to the employer's own URL.
  if (issueJobs[2]?.url === 'https://exampleco.example.net/') {
    pass('parseIssuePage() falls back to the Who link when the What link is a mailto:');
  } else {
    fail(`parseIssuePage() mailto fallback = ${JSON.stringify(issueJobs[2]?.url)}`);
  }

  // A listing with no fetchable destination is skipped, never given an invented URL.
  const mailtoOnly = parseIssuePage(
    '<p><strong>Jobs</strong></p>'
    + '<p><strong>What</strong>: <a href="/cdn-cgi/l/email-protection#abc">Program Assistant</a><br>'
    + '<strong>Who</strong>: A place that teaches things.<br>'
    + '<strong>Where</strong>: Chicago, IL</p>',
    { issueUrl: 'https://wordsofmouth.beehiiv.com/p/x' },
  );
  if (mailtoOnly.length === 0) pass('parseIssuePage() skips a listing with no fetchable destination');
  else fail(`parseIssuePage() mailto-only listing = ${JSON.stringify(mailtoOnly)}`);

  // --- broken vs empty -------------------------------------------------------
  // Labels still present, but no block parses (here: every label collapsed onto
  // one line, the shape a template rebuild takes) -> throw, not [].
  let threw = false;
  try {
    parseIssuePage(fixture('wordsofmouth-issue.html')
      .replace(/<br\s*\/?>/gi, ' '), { issueUrl: 'https://wordsofmouth.beehiiv.com/p/x' });
  } catch (err) {
    threw = /markup changed/.test(String(err?.message));
  }
  if (threw) pass('parseIssuePage() throws when What/Who labels survive but nothing parses (markup change)');
  else fail('parseIssuePage() should throw when the listing markup no longer parses');

  // An issue with no listing labels at all (a special edition) is legitimately empty.
  const emptyIssue = parseIssuePage('<p>Happy holidays. No jobs this week.</p>',
    { issueUrl: 'https://wordsofmouth.beehiiv.com/p/x' });
  if (Array.isArray(emptyIssue) && emptyIssue.length === 0) pass('parseIssuePage() returns [] for an issue with no Jobs section');
  else fail(`parseIssuePage() no-labels fixture = ${JSON.stringify(emptyIssue)}`);

  // --- recent_issues bound ---------------------------------------------------
  if (resolveRecentIssues({}) === 4 && resolveRecentIssues({ recent_issues: 2 }) === 2
    && resolveRecentIssues({ recent_issues: 9999 }) === 12) {
    pass('resolveRecentIssues() defaults to 4 and caps a configured value at 12');
  } else {
    fail(`resolveRecentIssues() = ${resolveRecentIssues({})} / ${resolveRecentIssues({ recent_issues: 2 })} / ${resolveRecentIssues({ recent_issues: 9999 })}`);
  }

  // --- fetch(): bounded walk, guards, probe cooperation ----------------------
  const ARCHIVE = fixture('wordsofmouth-archive.html');
  const ISSUE = fixture('wordsofmouth-issue.html');

  /** @param {{maxPages?: number, fail?: string, calls?: {url: string, opts: any}[]}} [o] */
  function stubCtx(o = {}) {
    const calls = o.calls ?? [];
    return {
      calls,
      maxPages: o.maxPages,
      fetchText: async (url, opts) => {
        calls.push({ url, opts });
        if (o.fail && url === o.fail) throw Object.assign(new Error('boom'), { status: 503 });
        return url === 'https://www.wordsofmouth.org/archive' ? ARCHIVE : ISSUE;
      },
    };
  }

  const ctx = stubCtx();
  const jobs = await provider.fetch({ name: 'Words of Mouth' }, ctx);
  if (jobs.length === 3) pass('fetch() returns the parsed postings of the newest issue');
  else fail(`fetch() returned ${jobs.length} jobs`);

  if (ctx.calls.length === 5) pass(`fetch() read the index plus ${ctx.calls.length - 1} issues (default bound = 4, archive holds 4)`);
  else fail(`fetch() made ${ctx.calls.length} requests`);

  if (ctx.calls.every((c) => c.opts?.redirect === 'error')) pass('fetch() passes redirect:"error" on every request');
  else fail(`fetch() request opts = ${JSON.stringify(ctx.calls.map((c) => c.opts))}`);

  if (ctx.calls.every((c) => /career-ops|Mozilla/i.test(c.opts?.headers?.['user-agent'] ?? ''))
    && ctx.calls.every((c) => !/compatible; career-ops/.test(c.opts.headers['user-agent']))) {
    pass('fetch() uses the shared browser-like UA (beehiiv 403s the plain career-ops UA)');
  } else {
    fail(`fetch() UA = ${JSON.stringify(ctx.calls.map((c) => c.opts?.headers?.['user-agent']))}`);
  }

  // Nothing but allowlisted hosts is ever requested.
  if (ctx.calls.every((c) => {
    const host = new URL(c.url).hostname;
    return host === 'www.wordsofmouth.org' || host === 'wordsofmouth.beehiiv.com'
      || host === 'mailchi.mp' || /^us\d+\.campaign-archive\d*\.com$/.test(host);
  })) {
    pass('fetch() requests only allowlisted hosts');
  } else {
    fail(`fetch() hosts = ${JSON.stringify(ctx.calls.map((c) => c.url))}`);
  }

  // The bound is on issues, so a small `recent_issues` cuts the walk.
  const small = stubCtx();
  await provider.fetch({ name: 'Words of Mouth', recent_issues: 2 }, small);
  if (small.calls.length === 3) pass('fetch() honours recent_issues (2 issues -> 3 requests)');
  else fail(`fetch() with recent_issues:2 made ${small.calls.length} requests`);

  // Probe: ctx.maxPages is the issue bound, and one rejection propagates unwrapped.
  const probe = stubCtx({ maxPages: 1 });
  await provider.fetch({ name: 'Words of Mouth', recent_issues: 4 }, probe);
  if (probe.calls.length === 2) pass('fetch() with ctx.maxPages:1 issues one index + one issue request');
  else fail(`fetch() under probe made ${probe.calls.length} requests`);

  let probeErr = null;
  try {
    await provider.fetch({ name: 'Words of Mouth' }, stubCtx({
      maxPages: 1,
      fail: 'https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme-museum-example-trust',
    }));
  } catch (err) {
    probeErr = err;
  }
  if (probeErr && probeErr.status === 503) pass('fetch() propagates a ctx.fetch* rejection unwrapped while probing');
  else fail(`fetch() probe rejection = ${JSON.stringify(probeErr?.message)}`);

  // A dead issue in a real scan must not lose the other issues.
  const partial = await provider.fetch({ name: 'Words of Mouth' }, stubCtx({
    fail: 'https://wordsofmouth.beehiiv.com/p/words-of-mouth-acme-museum-example-trust',
  }));
  if (partial.length === 3) pass('fetch() keeps the other issues when one issue fetch fails');
  else fail(`fetch() with one dead issue returned ${partial.length} jobs`);

  // A broken archive is a markup change, not a quiet source.
  let archiveThrew = false;
  try {
    await provider.fetch({ name: 'Words of Mouth' }, {
      fetchText: async () => '<html><body><p>Nothing here</p></body></html>',
    });
  } catch (err) {
    archiveThrew = /archive markup changed/.test(String(err?.message));
  }
  if (archiveThrew) pass('fetch() throws when the archive carries no allowlisted issue links');
  else fail('fetch() should throw when the archive index parses to nothing');

  // A dead target whose every issue fails must surface, not read as an empty board.
  let allDeadThrew = false;
  try {
    await provider.fetch({ name: 'Words of Mouth' }, {
      fetchText: async (url) => {
        if (url === 'https://www.wordsofmouth.org/archive') return ARCHIVE;
        throw Object.assign(new Error('gone'), { status: 404 });
      },
    });
  } catch (err) {
    allDeadThrew = /every issue fetch failed/.test(String(err?.message));
  }
  if (allDeadThrew) pass('fetch() throws when every issue fetch fails (no silent empty board)');
  else fail('fetch() should throw when all issue fetches fail');
} catch (err) {
  fail(`wordsofmouth provider test crashed: ${err?.stack || err}`);
}
