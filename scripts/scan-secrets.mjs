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

const exactGeneratedOrLockAllowlist = new Set([
  'mobile/package-lock.json',
  'mobile/src/domain/generated/unicode15.ts',
  'requirements.txt',
  'static/unicode_casefold.js',
  'uv.lock',
]);

function isGeneratedOrLock(path) {
  return exactGeneratedOrLockAllowlist.has(path);
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

function renderStartCommands(content) {
  const lines = content.split(/\r?\n/);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)startCommand:\s*(.*)$/.exec(lines[index]);
    if (match === null) continue;
    const fieldIndent = match[1].length;
    const scalar = match[2].trim();
    if (!/^[>|][+-]?$/.test(scalar)) {
      commands.push(scalar);
      continue;
    }
    const folded = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!next.trim()) {
        index += 1;
        continue;
      }
      const indentation = /^\s*/.exec(next)?.[0].length ?? 0;
      if (indentation <= fieldIndent) break;
      folded.push(next.trim());
      index += 1;
    }
    commands.push(folded.join(' '));
  }
  return commands;
}

function procfileWebCommands(content) {
  const lines = content.split(/\r?\n/);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^web:\s*(.*)$/.exec(lines[index]);
    if (match === null) continue;
    const parts = [match[1]];
    while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
      parts.push(lines[index + 1].trim());
      index += 1;
    }
    commands.push(parts.join(' ').replace(/\\\s+/g, ' '));
  }
  return commands;
}

function hasUnsafeGunicornCommand(path, content) {
  if (
    path === 'render.yaml' &&
    content.includes('gunicorn') &&
    /^\s*startCommand:\s*\|[+-]?\s*$/m.test(content)
  ) {
    return true;
  }
  const extracted = path === 'Procfile'
    ? procfileWebCommands(content)
    : renderStartCommands(content);
  const commands = extracted.filter(command => /(?:^|\s)gunicorn(?:\s|$)/.test(command));
  const invocationCount = commands.reduce(
    (count, command) => count + [...command.matchAll(/(?:^|\s)gunicorn(?:\s|$)/g)].length,
    0,
  );
  if (content.includes('gunicorn') && invocationCount !== 1) return true;
  return commands.some(command => {
    const normalized = command.replace(/\s+/g, ' ').trim();
    const accessLogValues = [
      ...normalized.matchAll(/--access-logfile(?:=|\s+)(\S+)/g),
    ].map(match => match[1]);
    const loggerClassValues = [
      ...normalized.matchAll(/--logger-class(?:=|\s+)(\S+)/g),
    ].map(match => match[1]);
    const logLevelValues = [
      ...normalized.matchAll(/--log-level(?:=|\s+)(\S+)/g),
    ].map(match => match[1]);
    return (
      accessLogValues.length !== 1 ||
      accessLogValues[0] !== '/dev/null' ||
      normalized.includes('--access-logformat') ||
      logLevelValues.length !== 1 ||
      logLevelValues[0] !== 'warning' ||
      loggerClassValues.length !== 1 ||
      loggerClassValues[0] !== 'server.gunicorn_logger.ContentFreeGunicornLogger'
    );
  });
}

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
    if (hasUnsafeGunicornCommand(path, content)) {
      violations.push('unsafe-gunicorn-access-log');
    }
  }
  const basename = path.split('/').at(-1);
  if (
    path !== '.env.example' &&
    (basename === '.env' || basename?.startsWith('.env.'))
  ) {
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
