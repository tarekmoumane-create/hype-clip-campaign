/**
 * Live check against the real provider.
 *
 *   npm run verify -- <url> [<url> ...]
 *
 * Parses each URL, calls the provider, and prints what came back. Use this to
 * confirm the field paths still hold after a vendor change, and to sanity-check
 * a platform you have not exercised yet.
 *
 * Each URL costs one API credit.
 */

import { config, assertProviderConfigured } from '../config.js';
import { parseSubmittedUrl } from '../parse/url.js';
import { getProvider, ProviderError } from '../providers/index.js';
import { formatViews } from '../render/card.js';

const urls = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

if (urls.length === 0) {
  console.error('Usage: npm run verify -- <tiktok-or-instagram-url> [...]');
  console.error('');
  console.error('Example:');
  console.error('  npm run verify -- https://www.tiktok.com/@stoolpresidente/video/7463250363559218474');
  process.exit(1);
}

assertProviderConfigured();

const provider = getProvider();
console.log(`provider: ${provider.name}`);
if (config.viewProvider === 'mock') {
  console.log('(VIEW_PROVIDER=mock — these numbers are synthetic)');
}
console.log('');

let failures = 0;

for (const input of urls) {
  console.log(`── ${input}`);

  const parsed = await parseSubmittedUrl(input);
  if (!parsed.ok) {
    console.log(`   PARSE FAILED  ${parsed.code}: ${parsed.message}`);
    console.log('');
    failures++;
    continue;
  }

  console.log(`   platform    : ${parsed.value.platform}`);
  console.log(`   external id : ${parsed.value.externalId}`);
  console.log(`   canonical   : ${parsed.value.canonicalUrl}`);
  if (parsed.value.wasShortLink) console.log('   (resolved from a short link)');

  try {
    const metrics = await provider.fetchMetrics(parsed.value);
    console.log(`   author      : @${metrics.authorHandle}${metrics.authorDisplayName ? ` (${metrics.authorDisplayName})` : ''}`);
    console.log(`   VIEWS       : ${metrics.views.toLocaleString()} (${formatViews(metrics.views)})`);
    console.log(`   likes       : ${metrics.likes?.toLocaleString() ?? '—'}`);
    console.log(`   comments    : ${metrics.comments?.toLocaleString() ?? '—'}`);
    console.log(`   shares      : ${metrics.shares?.toLocaleString() ?? '—'}`);
    console.log(`   posted      : ${metrics.postedAt ? new Date(metrics.postedAt * 1000).toISOString() : '—'}`);
    if (metrics.caption) console.log(`   caption     : ${metrics.caption.slice(0, 70)}`);
  } catch (error) {
    failures++;
    if (error instanceof ProviderError) {
      console.log(`   FETCH FAILED  ${error.code}${error.status ? ` (HTTP ${error.status})` : ''}`);
      console.log(`   ${error.message.slice(0, 300)}`);
      console.log(`   user-facing: "${error.userMessage()}"`);
    } else {
      console.log(`   FETCH FAILED  ${String(error)}`);
    }
  }
  console.log('');
}

if (failures > 0) {
  console.error(`${failures} of ${urls.length} failed.`);
  process.exit(1);
}
console.log(`All ${urls.length} OK.`);
