#!/usr/bin/env node
'use strict';

// Artifact-index versions are monotonically increasing integer snapshots, not releases.
// Keep the highest version numbers; upload timestamps are not Maven version ordering.
const PACKAGE_NAME = 'meta.artifact-index';
const API = 'https://api.github.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function options(args, env = process.env) {
  const result = {org: undefined, repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN || env.GITHUB_READ_PACKAGES_TOKEN,
    keep: 5, dry: false, verbose: false, help: false, interval: 1000};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--dry', '--dry-run'].includes(arg)) result.dry = true;
    else if (['-v', '--verbose'].includes(arg)) result.verbose = true;
    else if (['-h', '--help'].includes(arg)) result.help = true;
    else {
      const match = /^(--org|--repo|--keep|--token)(?:=(.*))?$/.exec(arg);
      if (!match) throw new Error(`Unknown option: ${arg.split('=')[0]}`);
      const value = match[2] ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${match[1]}`);
      result[{'--org':'org', '--repo':'repository', '--keep':'keep', '--token':'token'}[match[1]]] = value;
    }
  }
  if (result.help) return result;
  if (!result.token) throw new Error('Set GITHUB_TOKEN (or GITHUB_READ_PACKAGES_TOKEN); do not put credentials in command arguments.');
  if (!result.org || !/^[A-Za-z0-9-]+$/.test(result.org)) throw new Error('--org must name the package owner.');
  if (!/^\d+$/.test(String(result.keep)) || Number(result.keep) < 1 || Number(result.keep) > 10000) throw new Error('--keep must be an integer between 1 and 10000.');
  result.keep = Number(result.keep);
  if (!result.repository && !result.dry) throw new Error('--repo=OWNER/REPOSITORY is required for deletion.');
  if (result.repository && (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(result.repository) || result.repository.split('/')[0].toLowerCase() !== result.org.toLowerCase()))
    throw new Error('--repo must be a repository belonging to --org.');
  return result;
}

function plan(versions, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('At least one index version must be retained.');
  const ids = new Set(), names = new Set();
  for (const version of versions) {
    if (!Number.isSafeInteger(version.id) || version.id < 1 || ids.has(version.id)) throw new Error('Incomplete or duplicate version IDs; nothing deleted.');
    if (!/^\d+$/.test(version.name) || names.has(version.name)) throw new Error('Expected unique integer artifact-index versions; nothing deleted.');
    ids.add(version.id); names.add(version.name);
  }
  const sorted = [...versions].sort((a,b) => BigInt(a.name) === BigInt(b.name) ? b.id - a.id : BigInt(a.name) > BigInt(b.name) ? -1 : 1);
  return {retained: sorted.slice(0, keep), candidates: sorted.slice(keep)};
}

function client(token, {fetchImpl = fetch, pause = sleep} = {}) {
  return async function request(path, method = 'GET') {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(API + path, {method, redirect:'error', signal:AbortSignal.timeout(30000), headers:{
          Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json',
          'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'artifact-index-retention/1'
        }});
      } catch (error) {
        if (attempt >= 4) throw new Error(`${method} GitHub Packages: network request failed after retries.`, {cause:error});
        await pause(1000 * 2 ** attempt); continue;
      }
      if (response.ok || method === 'DELETE' && response.status === 404) return response;
      const retryAfter = response.headers.get('retry-after'), remaining = response.headers.get('x-ratelimit-remaining');
      const retryable = response.status >= 500 || response.status === 429 || response.status === 403 && (retryAfter !== null || remaining === '0');
      if (!retryable || attempt >= 4) {
        await response.text();
        throw new Error(`${method} GitHub Packages returned HTTP ${response.status}; token needs package read/delete scopes and package administration rights.`);
      }
      await response.text();
      const delay = retryAfter !== null ? Number(retryAfter) * 1000 : remaining === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now() : 1000 * 2 ** attempt;
      await pause(Math.max(1000, Number.isFinite(delay) ? delay : 60000));
    }
  };
}

async function cleanup(config, {request = client(config.token), log = console.log, pause = sleep, now = Date.now} = {}) {
  const base = `/orgs/${encodeURIComponent(config.org)}/packages/maven/${PACKAGE_NAME}`;
  const info = await (await request(base)).json();
  if (info.name !== PACKAGE_NAME || info.package_type !== 'maven' || !info.repository?.full_name || config.repository && info.repository.full_name.toLowerCase() !== config.repository.toLowerCase())
    throw new Error('Package ownership/repository does not match the requested artifact-index; nothing deleted.');
  const versions = [];
  for (let page = 1; ; page++) {
    if (page > 10000) throw new Error('Version pagination exceeded its limit; nothing deleted.');
    const values = await (await request(`${base}/versions?state=active&per_page=100&page=${page}`)).json();
    if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid version page; nothing deleted.');
    versions.push(...values);
    if (config.verbose) log(`Inventory: page ${page}, ${versions.length} versions.`);
    if (values.length < 100) break;
  }
  const selection = plan(versions, config.keep);
  log(`${info.repository.full_name}: ${versions.length} index versions; keep ${selection.retained.map(v=>v.name).join(', ') || '(none)'}; ${selection.candidates.length} deletion candidates.`);
  if (config.dry) {
    if (config.verbose) for (const version of selection.candidates) log(`[DRY] ${version.name} (ID ${version.id})`);
    return {...selection, deleted:0, absent:0};
  }
  if (selection.candidates.length === 0) return {...selection, deleted:0, absent:0};
  // Fail before any DELETE if the selected current index has disappeared meanwhile.
  const current = await (await request(`${base}/versions/${selection.retained[0].id}`)).json();
  if (current.name !== selection.retained[0].name) throw new Error('Retained index changed during planning; nothing deleted.');
  let deleted = 0, absent = 0, previous = -Infinity;
  for (const version of selection.candidates) {
    // Deliberately sequential and paced below GitHub's content-generating request limit.
    await pause(Math.max(0, config.interval - (now() - previous))); previous = now();
    const response = await request(`${base}/versions/${version.id}`, 'DELETE');
    await response.text();
    if (response.status === 404) absent++; else deleted++;
    const count = deleted + absent;
    if (config.verbose || count % 10 === 0 || count === selection.candidates.length) log(`Cleanup ${count}/${selection.candidates.length}: version ${version.name} (ID ${version.id}), HTTP ${response.status}; deleted ${deleted}, already absent ${absent}.`);
  }
  // A concurrent publisher can add newer versions. They are outside this plan and untouched.
  log(`Finished: retained ${selection.retained.length}, deleted ${deleted}, already absent ${absent}.`);
  return {...selection, deleted, absent};
}

const help = `Usage: GITHUB_TOKEN=... node delete-old-versions.js --org=OWNER --repo=OWNER/REPOSITORY [--keep=5] [--dry] [-v]

Only cleans the Maven package meta.artifact-index. Retains the highest integer
versions, not the newest upload timestamps. Repository ownership is verified.
--dry / --dry-run  Inventory and plan only; never delete
--keep=N          Retain N index snapshots (default 5, minimum 1)
--repo=OWNER/REPO  Expected backing repository; defaults to GITHUB_REPOSITORY
--org=OWNER       Package organization
-v / --verbose    Show inventory pages and individual progress
--token=...       Legacy compatibility only; prefer the environment
Requires Node.js 22+, package read/delete scopes and package administration rights.
Any failed inventory or deletion exits nonzero. No dependencies or SDK required.\n`;

if (require.main === module) {
  (async()=>{const config=options(process.argv.slice(2));if(config.help)console.log(help);else await cleanup(config);})()
    .catch(error=>{console.error(`Artifact-index cleanup failed: ${error.message}`);process.exitCode=1;});
}
module.exports = {options, plan, client, cleanup};
