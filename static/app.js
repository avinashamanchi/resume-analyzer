"use strict";

const CONSENT_VERSION = "2026-08-04.v1";
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_RESUME_CHARACTERS = 30000;
const MAX_JOB_DESCRIPTION_CHARACTERS = 20000;
const TOKEN_KEY = "resume-ai.installation-token.v1";
const MAX_ITEMS = 12;

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

const state = { mode: "pdf", file: null, controller: null, installationToken: null };
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
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* session memory is optional */ }
}

function clearToken() {
  state.installationToken = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* session memory is optional */ }
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
  try { return await response.json(); } catch { return {}; }
}

function safeError(data, fallback) {
  const code = data && typeof data.code === "string" ? data.code : "";
  return errorMessages[code] || fallback;
}

async function issueInstallation(signal) {
  const response = await fetch("/v1/installations", { method: "POST", signal, credentials: "same-origin" });
  const data = await responseData(response);
  if (!response.ok || !data || typeof data.installationToken !== "string" || !data.installationToken) {
    throw new Error(safeError(data, "A temporary browser token could not be issued. Try again later."));
  }
  saveToken(data.installationToken);
  return data.installationToken;
}

async function installationToken(signal) {
  if (state.installationToken) return state.installationToken;
  return issueInstallation(signal);
}

function safeText(value, maximum = 800) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function boundedItems(value, maximum = MAX_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map((item) => safeText(item, 600)).filter(Boolean);
}

function setList(id, values, className) {
  const list = document.querySelector(id);
  list.replaceChildren();
  const entries = values.length ? values : ["None identified in this review."];
  for (const entry of entries) {
    const item = document.createElement("li");
    if (className) item.className = className;
    item.textContent = entry;
    list.append(item);
  }
}

function scoreValue(score) {
  const value = score && Number.isInteger(score.readinessScore) ? score.readinessScore : null;
  return value !== null && value >= 0 && value <= 100 ? value : null;
}

function renderReport(data) {
  const score = data && typeof data.score === "object" && data.score ? data.score : {};
  const feedback = data && typeof data.feedback === "object" && data.feedback ? data.feedback : {};
  const readiness = scoreValue(score);
  if (readiness === null || !safeText(score.label, 40)) throw new Error("The readiness result could not be validated. You may submit again later.");

  document.querySelector("#readiness-score").textContent = String(readiness);
  document.querySelector("#readiness-label").textContent = safeText(score.label, 40);
  document.querySelector("#readiness-summary").textContent = safeText(feedback.summary, 500) || "No summary was returned for this review.";
  setList("#matched-keywords", boundedItems(feedback.matchedKeywords, 20));
  setList("#missing-keywords", boundedItems(feedback.missingKeywords, 20));
  setList("#strengths", boundedItems(feedback.strengths));
  setList("#improvements", boundedItems(feedback.improvements));
  setList("#power-bullets", boundedItems(feedback.powerBullets, 10));
  document.querySelector("#recruiter-comment").textContent = safeText(feedback.simulatedRecruiterComment, 800) || "No simulated recruiter comment was returned for this review.";
  report.hidden = false;
  report.focus();
}

async function submitAnalysis(event) {
  event.preventDefault();
  clearError();
  const validationError = localValidation();
  if (validationError) { showError(validationError); return; }

  const controller = new AbortController();
  state.controller = controller;
  report.hidden = true;
  setBusy(true);
  try {
    const formData = new FormData();
    formData.append("consent_version", CONSENT_VERSION);
    formData.append("request_id", crypto.randomUUID());
    const roleText = jobDescription.value.trim();
    if (roleText) formData.append("job_description", roleText);
    if (state.mode === "pdf") {
      formData.append("resume_pdf", state.file, state.file.name);
    } else {
      formData.append("resume_text", textInput.value.trim());
      formData.append("source_type", "text");
    }
    const token = await installationToken(controller.signal);
    const response = await fetch("/v1/analyses", {
      method: "POST",
      headers: { Authorization: `Installation ${token}` },
      body: formData,
      signal: controller.signal,
      credentials: "same-origin"
    });
    const data = await responseData(response);
    if (!response.ok) {
      if (response.status === 401) clearToken();
      throw new Error(safeError(data, "The review could not be completed. You may submit again when ready."));
    }
    renderReport(data);
  } catch (error) {
    if (error && error.name === "AbortError") {
      showError("Analysis canceled in this browser. You can edit your material before starting again.");
    } else {
      showError(error instanceof Error ? error.message : "The review could not be completed. You may submit again when ready.");
    }
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      setBusy(false);
    }
  }
}

state.installationToken = initialToken();
for (const radio of document.querySelectorAll("input[name='source']")) {
  radio.addEventListener("change", () => setMode(radio.value));
}
pdfInput.addEventListener("change", () => {
  state.file = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : null;
  fileName.textContent = state.file ? `${state.file.name} selected.` : "No file selected.";
  clearError();
});
form.addEventListener("submit", submitAnalysis);
cancelButton.addEventListener("click", () => { if (state.controller) state.controller.abort(); });
