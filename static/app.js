"use strict";

const CONSENT_VERSION = "2026-08-04.v1";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_RESUME_CHARACTERS = 30000;
const MAX_JOB_DESCRIPTION_CHARACTERS = 20000;
const TOKEN_KEY = "resume-ai.installation-token.v1";
const { validateAnalysisResponse, validateInstallationResponse, validatePublicError } = globalThis.ResumeAIContract;
const { RequestLifecycle } = globalThis.ResumeAILifecycle;

const errorMessages = {
  invalid_request: "Check the selected material and consent, then submit again.",
  invalid_installation: "This browser session needs a new access token. Submit again to request one.",
  rate_limited: "Too many requests were made from this network. Wait before trying again.",
  request_in_progress: "A request with this identifier is already in progress. Start a new review after it finishes.",
  unsupported_file: "Choose a PDF file for PDF upload.",
  file_too_large: "Choose a PDF smaller than 10 MB.",
  pdf_too_many_pages: "Choose a shorter PDF with fewer pages.",
  pdf_encrypted: "Choose a PDF without a password or encryption.",
  pdf_invalid: "Choose a valid, readable PDF.",
  pdf_timeout: "The PDF could not be read in time. Try a smaller, text-based PDF.",
  scan_required: "This PDF appears to be scanned. Paste its text instead.",
  resume_too_long: "Keep resume text to 30,000 characters or fewer.",
  scoring_input_limit: "Shorten the resume or role description before trying again.",
  ai_timeout: "The coaching service did not finish in time. You may submit again when ready.",
  ai_unavailable: "The coaching service is unavailable right now. You may submit again later.",
  invalid_ai_response: "The coaching result could not be validated. You may submit again later.",
  service_misconfigured: "This service is not ready. Contact support if this continues.",
  service_unavailable: "The service is unavailable. You may submit again later."
};

const state = { mode: "pdf", file: null, installationToken: null };
const lifecycle = new RequestLifecycle();
const form = document.querySelector("#analysis-form");
const pdfInput = document.querySelector("#resume-pdf");
const textInput = document.querySelector("#resume-text");
const jobDescription = document.querySelector("#job-description");
const consentInput = document.querySelector("#groq-consent");
const pdfPanel = document.querySelector("#pdf-panel");
const textPanel = document.querySelector("#text-panel");
const fileName = document.querySelector("#file-name");
const analyzeButton = document.querySelector("#analyze-button");
const cancelButton = document.querySelector("#cancel-button");
const errorBox = document.querySelector("#form-error");
const statusBox = document.querySelector("#request-status");
const report = document.querySelector("#report");

function initialToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function saveToken(token) {
  state.installationToken = token;
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* Session memory is optional. */ }
}

function clearToken() {
  state.installationToken = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* Session memory is optional. */ }
}

function setMode(mode) {
  state.mode = mode;
  const pdfMode = mode === "pdf";
  pdfPanel.hidden = !pdfMode;
  textPanel.hidden = pdfMode;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  errorBox.focus();
}

function clearError() {
  errorBox.textContent = "";
  errorBox.hidden = true;
}

function setBusy(isBusy) {
  analyzeButton.disabled = isBusy;
  cancelButton.hidden = !isBusy;
  statusBox.hidden = !isBusy;
  for (const control of form.elements) {
    if (control !== cancelButton) control.disabled = isBusy;
  }
  cancelButton.disabled = !isBusy;
}

function invalidateForEdit() {
  const hadActiveRequest = Boolean(lifecycle.active);
  lifecycle.invalidate();
  if (hadActiveRequest) setBusy(false);
}

function localValidation() {
  const resumeText = textInput.value.trim();
  const roleText = jobDescription.value.trim();
  if (!consentInput.checked) return "Confirm Groq consent before requesting AI coaching.";
  if (roleText.length > MAX_JOB_DESCRIPTION_CHARACTERS) return "Keep the role description to 20,000 characters or fewer.";
  if (state.mode === "pdf") {
    if (!state.file) return "Choose a resume PDF before starting the review.";
    if (state.file.size > MAX_PDF_BYTES) return "Choose a PDF smaller than 10 MB.";
    if (!state.file.name.toLowerCase().endsWith(".pdf")) return "Choose a PDF file for PDF upload.";
    return null;
  }
  if (!resumeText) return "Paste resume text before starting the review.";
  if (resumeText.length > MAX_RESUME_CHARACTERS) return "Keep resume text to 30,000 characters or fewer.";
  return null;
}

async function responseData(response) {
  try { return await response.json(); } catch { return null; }
}

function stableError(data, fallback) {
  try { return errorMessages[validatePublicError(data).code] || fallback; } catch { return fallback; }
}

async function issueInstallation(owner) {
  const response = await fetch("/v1/installations", {
    method: "POST",
    signal: owner.controller.signal,
    credentials: "same-origin"
  });
  if (!lifecycle.owns(owner)) return null;
  const data = await responseData(response);
  if (!lifecycle.owns(owner)) return null;
  if (response.status !== 201) throw new Error(stableError(data, "A temporary browser token could not be issued. Try again later."));
  const installation = validateInstallationResponse(data);
  saveToken(installation.installationToken);
  return installation.installationToken;
}

async function installationToken(owner) {
  if (state.installationToken) return state.installationToken;
  return issueInstallation(owner);
}

function setList(id, values) {
  const list = document.querySelector(id);
  list.replaceChildren();
  const entries = values.length ? values : ["None identified in this review."];
  for (const entry of entries) {
    const item = document.createElement("li");
    item.textContent = entry;
    list.append(item);
  }
}

function renderReport(analysis) {
  const { score, feedback } = analysis;
  document.querySelector("#readiness-score").textContent = String(score.readinessScore);
  document.querySelector("#readiness-label").textContent = score.label;
  document.querySelector("#readiness-summary").textContent = feedback.summary;
  setList("#matched-keywords", feedback.matchedKeywords);
  setList("#missing-keywords", feedback.missingKeywords);
  setList("#strengths", feedback.strengths);
  setList("#improvements", feedback.improvements);
  setList("#power-bullets", feedback.powerBullets);
  document.querySelector("#recruiter-comment").textContent = feedback.simulatedRecruiterComment;
  report.hidden = false;
  report.focus();
}

function requestPayload() {
  const formData = new FormData();
  formData.append("consent_version", CONSENT_VERSION);
  formData.append("request_id", crypto.randomUUID());
  const roleText = jobDescription.value.trim();
  const context = Object.freeze({ hasJobDescription: roleText.length > 0 });
  if (roleText) formData.append("job_description", roleText);
  if (state.mode === "pdf") {
    formData.append("resume_pdf", state.file, state.file.name);
  } else {
    formData.append("resume_text", textInput.value.trim());
    formData.append("source_type", "text");
  }
  return Object.freeze({ formData, context });
}

async function submitAnalysis(event) {
  event.preventDefault();
  clearError();
  const validationError = localValidation();
  if (validationError) { showError(validationError); return; }

  const payload = requestPayload();
  const owner = lifecycle.begin(new AbortController());
  report.hidden = true;
  setBusy(true);
  try {
    const token = await installationToken(owner);
    if (!lifecycle.owns(owner)) return;
    if (!token) return;
    const response = await fetch("/v1/analyses", {
      method: "POST",
      headers: { Authorization: `Installation ${token}` },
      body: payload.formData,
      signal: owner.controller.signal,
      credentials: "same-origin"
    });
    if (!lifecycle.owns(owner)) return;
    const data = await responseData(response);
    if (!lifecycle.owns(owner)) return;
    if (response.status !== 200) {
      if (response.status === 401) clearToken();
      throw new Error(stableError(data, "The review could not be completed. You may submit again when ready."));
    }
    const analysis = validateAnalysisResponse(data, payload.context);
    lifecycle.applyIfCurrent(owner, () => renderReport(analysis));
  } catch (error) {
    if (!lifecycle.owns(owner)) return;
    if (error && error.name === "AbortError") {
      showError("Analysis canceled in this browser. You can edit your material before starting again.");
    } else {
      showError(error instanceof Error ? error.message : "The review could not be completed. You may submit again when ready.");
    }
  } finally {
    lifecycle.applyIfCurrent(owner, () => {
      lifecycle.finish(owner);
      setBusy(false);
    });
  }
}

state.installationToken = initialToken();
for (const radio of document.querySelectorAll("input[name='source']")) {
  radio.addEventListener("change", () => {
    invalidateForEdit();
    setMode(radio.value);
  });
}
pdfInput.addEventListener("change", () => {
  invalidateForEdit();
  state.file = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : null;
  fileName.textContent = state.file ? `${state.file.name} selected.` : "No file selected.";
  clearError();
});
textInput.addEventListener("input", invalidateForEdit);
jobDescription.addEventListener("input", invalidateForEdit);
form.addEventListener("reset", () => {
  lifecycle.invalidate();
  setBusy(false);
  queueMicrotask(() => {
    state.file = null;
    fileName.textContent = "No file selected.";
    setMode("pdf");
  });
});
form.addEventListener("submit", submitAnalysis);
cancelButton.addEventListener("click", () => {
  const owner = lifecycle.active;
  if (!owner) {
    lifecycle.invalidate();
    return;
  }
  lifecycle.cancel(owner);
  setBusy(false);
  showError("Analysis canceled in this browser. You can edit your material before starting again.");
});
window.addEventListener("pagehide", () => lifecycle.pagehide());
