#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIT_LEVEL = '--audit-level=high';
const ALLOWED_ADVISORY_SOURCES = new Set([1138808, 1138809]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['audit', AUDIT_LEVEL, '--json'], {
  cwd: resolve(root, 'mobile'),
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

if (result.error !== undefined || ![0, 1].includes(result.status ?? -1)) {
  process.stderr.write('Mobile dependency audit could not be executed.\n');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write('Mobile dependency audit returned invalid JSON.\n');
  process.exit(2);
}

if (typeof report !== 'object' || report === null || Array.isArray(report)) {
  process.stderr.write('Mobile dependency audit returned an invalid report shape.\n');
  process.exit(2);
}
if (
  report.error !== undefined ||
  typeof report.vulnerabilities !== 'object' ||
  report.vulnerabilities === null ||
  Array.isArray(report.vulnerabilities)
) {
  process.stderr.write('Mobile dependency audit returned an error or incomplete report.\n');
  process.exit(2);
}

const vulnerabilities = report.vulnerabilities;
const severe = new Map(Object.entries(vulnerabilities).filter(([, value]) => (
  value?.severity === 'high' || value?.severity === 'critical'
)));

if (severe.size === 0) {
  if (result.status !== 0) {
    process.stderr.write('Mobile dependency audit exited nonzero without a reviewable severe finding.\n');
    process.exit(2);
  }
  process.stdout.write('Mobile dependency audit passed with no high or critical findings.\n');
  process.exit(0);
}

const failures = [];
for (const [name, value] of severe) {
  if (value.severity === 'critical') failures.push(`${name}:critical`);
  for (const cause of value.via ?? []) {
    if (typeof cause === 'string') {
      if (!severe.has(cause)) failures.push(`${name}:unknown-chain`);
      continue;
    }
    if (!ALLOWED_ADVISORY_SOURCES.has(cause?.source)) {
      failures.push(`${name}:advisory-${String(cause?.source ?? 'unknown')}`);
    }
  }
}

function reachesAllowedAdvisory(name, visiting = new Set()) {
  if (visiting.has(name)) return false;
  const value = severe.get(name);
  if (value === undefined) return false;
  const next = new Set(visiting).add(name);
  return (value.via ?? []).some((cause) => (
    typeof cause === 'string'
      ? reachesAllowedAdvisory(cause, next)
      : ALLOWED_ADVISORY_SOURCES.has(cause?.source)
  ));
}

for (const name of severe.keys()) {
  if (!reachesAllowedAdvisory(name)) failures.push(`${name}:unproven-chain`);
}

if (failures.length > 0) {
  process.stderr.write(`Mobile dependency audit failed closed: ${[...new Set(failures)].sort().join(', ')}.\n`);
  process.exit(1);
}

process.stdout.write(
  `Mobile dependency audit accepted ${severe.size} transitive findings rooted only in ` +
  'GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq; any new high or critical advisory fails closed.\n',
);
