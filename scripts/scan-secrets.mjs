#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

function parseRepository(arguments_) {
  const index = arguments_.indexOf('--repo');
  if (index === -1) return process.cwd();
  if (index + 1 >= arguments_.length || arguments_.length !== 2) {
    throw new Error('usage');
  }
  return resolve(arguments_[index + 1]);
}

function trackedFiles(repository) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return output.split('\0').filter(Boolean);
}

function isGeneratedOrLock(path) {
  return (
    path.endsWith('package-lock.json') ||
    path === 'uv.lock' ||
    path === 'requirements.txt' ||
    path.includes('/generated/') ||
    path === 'static/unicode_casefold.js'
  );
}

const globalRules = [
  ['groq-key', /\bgsk_[A-Za-z0-9_-]{24,}\b/],
  ['anthropic-key', /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{32,}\b/],
  ['openai-key', /\bsk-[A-Za-z0-9_-]{32,}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];

const productionRules = [
  ['production-placeholder-secret', /(?:GROQ_API_KEY|INSTALLATION_SIGNING_KEY)\s*[:=]\s*["']?(?:change-me|placeholder|replace|example|your[_-])/i],
  ['permissive-cors', /ALLOWED_WEB_ORIGINS\s*[:=]\s*["']?\*["']?/i],
  ['debug-enabled', /(?:app\.run\s*\([^)]*debug\s*=\s*True|DEBUG\s*[:=]\s*["']?(?:true|1|yes|on)\b)/i],
  ['request-header-log', /(?:log(?:ger|ging)?|print)\s*\.?(?:info|debug|warning|error)?\s*\([^\n]*(?:request\.(?:headers|cookies)|authorization)/i],
  ['request-body-log', /(?:log(?:ger|ging)?|print)\s*\.?(?:info|debug|warning|error)?\s*\([^\n]*request\.(?:get_json|data|form|files|body)/i],
];

function violationsFor(path, content) {
  const violations = [];
  for (const [rule, pattern] of globalRules) {
    if (pattern.test(content)) violations.push(rule);
  }
  if (
    path.startsWith('server/') ||
    path.startsWith('static/') ||
    path.startsWith('mobile/src/') ||
    path.startsWith('mobile/app/') ||
    path === 'app.py' ||
    path === 'render.yaml' ||
    path === 'Procfile'
  ) {
    for (const [rule, pattern] of productionRules) {
      if (pattern.test(content)) violations.push(rule);
    }
  }
  if (path === 'render.yaml' && /(?:GROQ_API_KEY|INSTALLATION_SIGNING_KEY)[\s\S]{0,100}value:\s*(?:change-me|placeholder|replace|example)/i.test(content)) {
    violations.push('production-placeholder-secret');
  }
  if (path === 'Procfile' || path === 'render.yaml') {
    const gunicornCommands = content.split('\n').filter(line => line.includes('gunicorn'));
    if (
      gunicornCommands.some(line => /--access-logfile(?:=|\s+)-(?:\s|$)/.test(line)) ||
      content.includes('--access-logformat') ||
      (path === 'Procfile' && content.includes('gunicorn') && !content.includes('--access-logfile /dev/null'))
    ) {
      violations.push('unsafe-gunicorn-access-log');
    }
  }
  if ((path === '.env' || (/^\.env\./.test(path) && path !== '.env.example'))) {
    violations.push('committed-env');
  }
  return violations;
}

let repository;
try {
  repository = parseRepository(process.argv.slice(2));
} catch {
  process.stderr.write('Secret scan failed: invalid arguments.\n');
  process.exit(2);
}

let files;
try {
  files = trackedFiles(repository);
} catch {
  process.stderr.write('Secret scan failed: repository is not available.\n');
  process.exit(2);
}

const scanned = files.filter(path => !isGeneratedOrLock(path));
const findings = [];
for (const path of scanned) {
  let content;
  try {
    content = readFileSync(resolve(repository, path), 'utf8');
  } catch {
    findings.push({ path, rule: 'unreadable-tracked-file' });
    continue;
  }
  for (const rule of violationsFor(path, content)) findings.push({ path, rule });
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed: prohibited content in ${findings.length} tracked location${findings.length === 1 ? '' : 's'}.\n`);
  for (const finding of findings) {
    const safePath = relative(repository, resolve(repository, finding.path)).split(sep).join('/');
    process.stderr.write(`- ${safePath}: ${finding.rule}\n`);
  }
  process.exit(1);
}

process.stdout.write(`Secret scan passed for ${scanned.length} tracked file${scanned.length === 1 ? '' : 's'}.\n`);
