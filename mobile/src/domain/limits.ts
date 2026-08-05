import { hasUnicode15Data, isPythonStripCharacter } from './generated/unicode15';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 11 * 1024 * 1024;
export const MAX_RESUME_CODE_POINTS = 30_000;
export const MAX_JOB_DESCRIPTION_CODE_POINTS = 20_000;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function trimPythonWhitespace(value: string): string | null {
  if (!hasUnicode15Data()) return null;
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && isPythonStripCharacter(characters[start])) start += 1;
  while (end > start && isPythonStripCharacter(characters[end - 1])) end -= 1;
  return characters.slice(start, end).join('');
}

export function isNonBlankPythonText(value: string): boolean {
  const trimmed = trimPythonWhitespace(value);
  return trimmed !== null && trimmed.length > 0;
}
