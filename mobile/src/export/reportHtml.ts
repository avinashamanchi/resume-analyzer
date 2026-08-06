import type { ReportRecord } from '../storage/reportRepository';

export function escapeReportHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function list(items: readonly string[], empty: string): string {
  const values = items.length === 0 ? [empty] : items;
  return `<ul>${values.map(item => `<li>${escapeReportHtml(item)}</li>`).join('')}</ul>`;
}

function component(label: string, value: number | null, maximum: number): string {
  const display = value === null ? 'Not scored' : `${value}/${maximum}`;
  return `<tr><th scope="row">${escapeReportHtml(label)}</th><td>${display}</td></tr>`;
}

export function buildReportHtml(report: ReportRecord): string {
  const hasKeywords = report.score.components.keywords !== null;
  const componentRows = hasKeywords
    ? [
      component('Structure', report.score.components.structure, 25),
      component('Impact', report.score.components.impact, 30),
      component('Readability', report.score.components.readability, 20),
      component('Keywords', report.score.components.keywords, 25),
    ]
    : [
      component('Structure', report.score.components.structure, 30),
      component('Impact', report.score.components.impact, 40),
      component('Readability', report.score.components.readability, 30),
    ];
  const methodology = hasKeywords
    ? `The deterministic ${escapeReportHtml(report.score.scoreVersion)} method assigns structure up to 25 points, impact up to 30 points, readability up to 20 points, and keyword alignment up to 25 points. These components total at most 100 points.`
    : `The deterministic ${escapeReportHtml(report.score.scoreVersion)} method assigns structure up to 30 points, impact up to 40 points, and readability up to 30 points. No job-description component is included in this score.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeReportHtml(report.title)}</title>
  <style>
    @page { margin: 44px; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #15191b; background: #ffffff; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 12pt; line-height: 1.5; }
    header { border-bottom: 2px solid #25795f; padding-bottom: 18px; margin-bottom: 24px; }
    h1 { margin: 4px 0 8px; font-size: 26pt; line-height: 1.15; }
    h2 { margin: 0 0 10px; font-size: 16pt; line-height: 1.3; }
    p { margin: 0 0 10px; }
    section { break-inside: avoid; margin: 0 0 24px; }
    ul { margin: 0; padding-left: 22px; }
    li { margin-bottom: 7px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #d9dfdc; padding: 8px 0; text-align: left; }
    td { text-align: right; font-weight: 700; }
    .eyebrow { color: #25795f; font-size: 9pt; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; }
    .score { font-size: 22pt; font-weight: 800; }
    .label { display: inline-block; margin-left: 8px; font-size: 13pt; font-weight: 800; }
    .note { color: #48514d; font-size: 10pt; }
    .disclaimer { border: 1px solid #8b6423; padding: 14px; }
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">Resume.AI report</div>
    <h1>${escapeReportHtml(report.title)}</h1>
    <p class="note">Created ${escapeReportHtml(report.createdAt.slice(0, 10))}. This export contains the bounded report only, never resume text, a source PDF, a job description, or an installation token.</p>
  </header>
  <main>
    <section aria-labelledby="score-heading">
      <h2 id="score-heading">Resume readiness score</h2>
      <p><span class="score">${report.score.readinessScore}/100</span><span class="label">${escapeReportHtml(report.score.label)}</span></p>
      <table aria-label="Score components"><tbody>
        ${componentRows.join('\n        ')}
      </tbody></table>
      ${list(report.score.explanations, 'No score explanations were returned.')}
    </section>
    <section aria-labelledby="method-heading">
      <h2 id="method-heading">Score methodology</h2>
      <p>${methodology} AI feedback cannot alter this score or its components.</p>
    </section>
    <section aria-labelledby="summary-heading"><h2 id="summary-heading">Editorial summary</h2><p>${escapeReportHtml(report.feedback.summary)}</p></section>
    <section aria-labelledby="matched-heading"><h2 id="matched-heading">Matched keywords</h2>${list(report.feedback.matchedKeywords, hasKeywords ? 'No matched terms were identified.' : 'Not scored because no job description was supplied.')}</section>
    <section aria-labelledby="missing-heading"><h2 id="missing-heading">Missing keywords</h2>${list(report.feedback.missingKeywords, hasKeywords ? 'No missing terms were identified.' : 'Not scored because no job description was supplied.')}</section>
    <section aria-labelledby="strengths-heading"><h2 id="strengths-heading">Strengths</h2>${list(report.feedback.strengths, 'No strengths were returned.')}</section>
    <section aria-labelledby="improvements-heading"><h2 id="improvements-heading">Improvements</h2>${list(report.feedback.improvements, 'No improvements were returned.')}</section>
    <section aria-labelledby="bullets-heading"><h2 id="bullets-heading">Power bullet drafts</h2>${list(report.feedback.powerBullets, 'No bullet drafts were returned.')}</section>
    <section aria-labelledby="simulated-heading"><h2 id="simulated-heading">Simulated AI feedback</h2><p>${escapeReportHtml(report.feedback.simulatedRecruiterComment)}</p></section>
    <section class="disclaimer" aria-labelledby="limits-heading">
      <h2 id="limits-heading">Important limitations</h2>
      <p>AI-generated guidance may be incorrect. This report is coaching guidance, not an ATS result, employer decision, hiring prediction, or guarantee of interviews or employment.</p>
    </section>
  </main>
</body>
</html>`;
}
