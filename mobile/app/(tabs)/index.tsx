import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAppController } from '../../src/controllers/AppController';
import { AnalysisStatus } from '../../src/components/AnalysisStatus';
import { ConsentSheet } from '../../src/components/ConsentSheet';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { SourcePicker, type SourceMode } from '../../src/components/SourcePicker';
import { createPastedTextSource } from '../../src/documents/documentSource';
import {
  codePointLength,
  isNonBlankPythonText,
  MAX_JOB_DESCRIPTION_CODE_POINTS,
  MAX_RESUME_CODE_POINTS,
} from '../../src/domain/limits';
import { tokens } from '../../src/theme/tokens';

const INPUT_ERROR = 'Check the resume and job-description limits before analyzing.';

type VisionDraftEditor = Readonly<{
  text: string;
  pageCount: number;
  generation: number;
}>;

export default function AnalyzeScreen() {
  const router = useRouter();
  const { analysis, actions } = useAppController();
  const { state, commands } = analysis;
  const [mode, setMode] = useState<SourceMode>(state.source?.kind === 'text' ? 'paste' : 'pdf');
  const [pdfDisplay, setPdfDisplay] = useState<Readonly<{
    sourceIdentity: symbol;
    sourceGeneration: number;
    displayName: string;
  }> | null>(null);
  const [pasteText, setPasteText] = useState(state.source?.kind === 'text' ? state.source.text : '');
  const [jobDescription, setJobDescription] = useState(state.jobDescription);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerPending, setPickerPending] = useState(false);
  const [visionPending, setVisionPending] = useState(false);
  const [visionDraft, setVisionDraft] = useState<VisionDraftEditor | null>(null);
  const [reviewedVisionReady, setReviewedVisionReady] = useState(false);
  const [visionAnnouncementRevision, setVisionAnnouncementRevision] = useState(0);
  const priorGeneration = useRef(state.generation);
  const priorLifecycleEpoch = useRef(state.lifecycleEpoch);
  const operationEpoch = useRef(0);
  const pickerController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const visionEditor = useRef<TextInput | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationEpoch.current += 1;
      pickerController.current?.abort();
      pickerController.current = null;
    };
  }, []);

  useFocusEffect(useCallback(() => () => {
    operationEpoch.current += 1;
    pickerController.current?.abort();
    pickerController.current = null;
    if (mounted.current) {
      setPickerPending(false);
      setVisionPending(false);
      setVisionDraft(null);
      setReviewedVisionReady(false);
      setBusy(false);
    }
    void commands.cancelVisionExtraction();
  }, [commands]));

  useEffect(() => {
    if (visionAnnouncementRevision === 0 || visionDraft === null) return;
    AccessibilityInfo.announceForAccessibility(
      'OCR draft ready. Review and edit the extracted text.',
    );
    visionEditor.current?.focus();
    const handle = findNodeHandle(visionEditor.current);
    if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
  }, [visionAnnouncementRevision]);

  useEffect(() => {
    if (state.lifecycleEpoch !== priorLifecycleEpoch.current) {
      operationEpoch.current += 1;
      pickerController.current?.abort();
      pickerController.current = null;
      setPickerPending(false);
      setBusy(false);
      setVisionPending(false);
      setVisionDraft(null);
      setReviewedVisionReady(false);
    }
    priorLifecycleEpoch.current = state.lifecycleEpoch;
  }, [state.lifecycleEpoch]);

  const beginOperation = () => {
    operationEpoch.current += 1;
    pickerController.current?.abort();
    pickerController.current = null;
    setPickerPending(false);
    return operationEpoch.current;
  };

  const operationIsCurrent = (epoch: number) =>
    mounted.current && operationEpoch.current === epoch;

  useEffect(() => {
    if (state.status === 'succeeded' && state.result !== null) {
      router.replace(`/results/${state.result.analysisId}`);
    }
  }, [router, state.result, state.status]);

  useEffect(() => {
    if (
      state.generation !== priorGeneration.current &&
      state.status === 'idle' &&
      state.source === null &&
      state.jobDescription.length === 0
    ) {
      setPdfDisplay(null);
      setPasteText('');
      setJobDescription('');
      setLocalError(null);
      setVisionDraft(null);
      setReviewedVisionReady(false);
    }
    priorGeneration.current = state.generation;
  }, [state.generation, state.jobDescription, state.source, state.status]);

  useEffect(() => {
    if (visionDraft !== null && state.generation !== visionDraft.generation) {
      setVisionDraft(null);
    }
  }, [state.generation, visionDraft]);

  useEffect(() => {
    if (
      pdfDisplay !== null &&
      state.generation >= pdfDisplay.sourceGeneration &&
      (state.source?.kind !== 'pdf' || state.source.lease !== pdfDisplay.sourceIdentity) &&
      state.mutation === 'none'
    ) {
      setPdfDisplay(null);
    }
  }, [pdfDisplay, state.generation, state.mutation, state.source]);

  const changeMode = async (next: SourceMode) => {
    if (next === mode || (busy && !pickerPending) || state.status === 'analyzing') return;
    const epoch = beginOperation();
    setBusy(true);
    setLocalError(null);
    await commands.reset();
    if (!operationIsCurrent(epoch)) return;
    setPdfDisplay(null);
    setPasteText('');
    setJobDescription('');
    setVisionDraft(null);
    setReviewedVisionReady(false);
    setMode(next);
    setBusy(false);
  };

  const choosePdf = async () => {
    if (state.privacyReadiness !== 'ready' || (busy && !pickerPending)) return;
    const epoch = beginOperation();
    const controller = new AbortController();
    pickerController.current = controller;
    setBusy(true);
    setPickerPending(true);
    setLocalError(null);
    setVisionDraft(null);
    setReviewedVisionReady(false);
    try {
      const picked = await actions.pickPdfForDisplay(controller.signal);
      if (operationIsCurrent(epoch) && picked !== null) {
        setPdfDisplay(picked);
      }
    } catch {
      if (operationIsCurrent(epoch)) setLocalError('The PDF could not be selected safely.');
    } finally {
      if (operationIsCurrent(epoch)) {
        if (pickerController.current === controller) pickerController.current = null;
        setPickerPending(false);
        setBusy(false);
      }
    }
  };

  const extractOnDevice = async () => {
    if (busy || state.mutation !== 'none' || state.status !== 'failed') return;
    const epoch = beginOperation();
    setBusy(true);
    setVisionPending(true);
    setLocalError(null);
    try {
      const receipt = await commands.extractVisionDraft();
      if (!operationIsCurrent(epoch)) return;
      if (!receipt.completed) {
        setLocalError('On-device text extraction could not finish. Paste the resume text instead.');
        return;
      }
      setPdfDisplay(null);
      setVisionDraft({
        text: receipt.draft.text,
        pageCount: receipt.draft.pageCount ?? 1,
        generation: receipt.generation,
      });
      setReviewedVisionReady(false);
      setVisionAnnouncementRevision(current => current + 1);
    } finally {
      if (operationIsCurrent(epoch)) {
        setVisionPending(false);
        setBusy(false);
      }
    }
  };

  const cancelExtraction = async () => {
    const epoch = beginOperation();
    setBusy(true);
    setVisionPending(true);
    await commands.cancelVisionExtraction();
    if (!operationIsCurrent(epoch)) return;
    setVisionPending(false);
    setBusy(false);
  };

  const completeVisionReview = async () => {
    if (visionDraft === null || busy) return;
    if (
      visionDraft.text.includes('\0') ||
      codePointLength(visionDraft.text) > MAX_RESUME_CODE_POINTS ||
      !isNonBlankPythonText(visionDraft.text)
    ) {
      setLocalError(INPUT_ERROR);
      return;
    }
    const epoch = beginOperation();
    setBusy(true);
    setLocalError(null);
    const receipt = await commands.selectSource({
      kind: 'vision_text',
      text: visionDraft.text,
      reviewed: true,
      pageCount: visionDraft.pageCount,
    });
    if (!operationIsCurrent(epoch)) return;
    if (!receipt.committed) {
      setBusy(false);
      setLocalError(INPUT_ERROR);
      return;
    }
    setVisionDraft(null);
    setReviewedVisionReady(true);
    setBusy(false);
    AccessibilityInfo.announceForAccessibility('OCR review complete. Ready to analyze.');
  };

  const cancelVisionReview = async () => {
    const epoch = beginOperation();
    setVisionDraft(null);
    setReviewedVisionReady(false);
    setBusy(true);
    setLocalError(null);
    await commands.reset();
    if (!operationIsCurrent(epoch)) return;
    setBusy(false);
    AccessibilityInfo.announceForAccessibility('OCR review cancelled. Extracted text cleared.');
  };

  const analyze = async () => {
    if ((busy && !pickerPending) || state.status === 'analyzing') return;
    const epoch = beginOperation();
    setBusy(true);
    setLocalError(null);
    try {
      if (mode === 'paste') {
        const sourceReceipt = await commands.selectSource(createPastedTextSource(pasteText));
        if (!operationIsCurrent(epoch)) return;
        if (!sourceReceipt.committed) throw new Error(INPUT_ERROR);
      } else if (state.source?.kind !== 'pdf' && state.source?.kind !== 'vision_text') {
        throw new Error(INPUT_ERROR);
      }
      if (jobDescription.includes('\0') || codePointLength(jobDescription) > MAX_JOB_DESCRIPTION_CODE_POINTS) {
        throw new Error(INPUT_ERROR);
      }
      const jobReceipt = await commands.setJobDescription(jobDescription);
      if (!operationIsCurrent(epoch)) return;
      if (!jobReceipt.committed) throw new Error(INPUT_ERROR);
      Keyboard.dismiss();
      await commands.analyze();
    } catch {
      if (operationIsCurrent(epoch)) setLocalError(INPUT_ERROR);
    } finally {
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const working = (busy && !pickerPending) || state.mutation !== 'none';
  const scanRequired = state.status === 'failed' &&
    state.error?.code === 'scan_required' &&
    state.source?.kind === 'pdf';
  const visionAvailable = scanRequired && commands.isVisionAvailable();
  const reviewedVision = reviewedVisionReady || state.source?.kind === 'vision_text';
  const displayName = pdfDisplay !== null &&
    state.source?.kind === 'pdf' &&
    state.source.lease === pdfDisplay.sourceIdentity
    ? pdfDisplay.displayName
    : null;
  return (
    <>
      <Screen bottomInset="tab-bar">
        <View style={styles.hero}>
          <Eyebrow>Resume.AI · private by default</Eyebrow>
          <Title>A clearer read on your resume.</Title>
          <Text style={styles.heroCopy}>
            Review structure, evidence, readability, and job-language alignment. Results are guidance—not an ATS verdict or hiring prediction.
          </Text>
        </View>

        {visionDraft === null ? (
          <SourcePicker
            mode={mode}
            displayName={displayName}
            busy={working || state.status === 'analyzing' || state.privacyReadiness !== 'ready'}
            onModeChange={next => { void changeMode(next); }}
            onChoosePdf={() => { void choosePdf(); }}
          />
        ) : (
          <Card>
            <View style={styles.inputHeading}>
              <Text style={uiStyles.sectionTitle}>Review extracted text</Text>
              <Text style={styles.count}>
                {codePointLength(visionDraft.text).toLocaleString()} / {MAX_RESUME_CODE_POINTS.toLocaleString()}
              </Text>
            </View>
            <Text
              testID="vision-review-status"
              accessibilityLiveRegion="polite"
              style={uiStyles.muted}>
              OCR can make mistakes. Check every section before marking this {visionDraft.pageCount}-page draft complete.
            </Text>
            <TextInput
              ref={visionEditor}
              accessibilityLabel="Review extracted resume text"
              accessibilityHint="Edit recognition mistakes before marking the review complete."
              multiline
              value={visionDraft.text}
              onChangeText={text => setVisionDraft(current => current === null ? null : { ...current, text })}
              editable={!working}
              style={[uiStyles.input, styles.visionInput]}
            />
            <AppButton
              label="Review complete"
              accessibilityHint="Marks this edited OCR text as reviewed. It does not start analysis."
              onPress={() => { void completeVisionReview(); }}
              disabled={working || visionDraft.text.includes('\0') || codePointLength(visionDraft.text) > MAX_RESUME_CODE_POINTS}
            />
            <AppButton
              label="Cancel OCR review"
              accessibilityHint="Clears the extracted text without analyzing it."
              onPress={() => { void cancelVisionReview(); }}
              disabled={working}
              tone="quiet"
            />
          </Card>
        )}

        {scanRequired && visionDraft === null && !reviewedVision && !visionPending ? (
          <Card style={styles.scanCard}>
            <Text style={uiStyles.sectionTitle}>This PDF appears to be scanned</Text>
            {visionAvailable ? (
              <>
                <Text style={uiStyles.body}>
                  A Resume.AI development build can use Apple Vision on this iPhone. You must review the extracted text before analysis.
                </Text>
                <AppButton
                  label="Extract on this iPhone"
                  accessibilityHint="Starts private on-device text recognition, then opens an editable review."
                  onPress={() => { void extractOnDevice(); }}
                  disabled={working}
                />
              </>
            ) : (
              <Text style={uiStyles.body}>
                On-device Apple Vision extraction requires a Resume.AI development build and isn't available in Expo Go. Paste the resume text instead.
              </Text>
            )}
            <AppButton
              label="Paste resume text instead"
              accessibilityHint="Removes the temporary PDF and opens the paste-text editor."
              onPress={() => { void changeMode('paste'); }}
              disabled={working}
              tone="secondary"
            />
          </Card>
        ) : null}

        {visionPending ? (
          <Card>
            <Text accessibilityRole="alert" style={uiStyles.sectionTitle}>Extracting on this iPhone…</Text>
            <Text style={uiStyles.muted}>Keep Resume.AI open. The PDF and page images stay on this device.</Text>
            <AppButton
              label="Cancel extraction"
              accessibilityHint="Stops this review flow and removes the temporary PDF after native work releases it."
              onPress={() => { void cancelExtraction(); }}
              tone="quiet"
            />
          </Card>
        ) : null}

        {reviewedVision ? (
          <Card style={styles.scanCard}>
            <Text style={uiStyles.sectionTitle}>Reviewed scan ready</Text>
            <Text style={uiStyles.body}>The temporary PDF is removed. Analysis will send only the reviewed text after your explicit Analyze action.</Text>
          </Card>
        ) : null}

        {mode === 'paste' ? (
          <Card>
            <View style={styles.inputHeading}>
              <Text style={uiStyles.sectionTitle}>Resume text</Text>
              <Text style={styles.count}>{codePointLength(pasteText).toLocaleString()} / {MAX_RESUME_CODE_POINTS.toLocaleString()}</Text>
            </View>
            <TextInput
              accessibilityLabel="Paste resume text"
              multiline
              value={pasteText}
              onChangeText={setPasteText}
              editable={!working && state.status !== 'analyzing'}
              placeholder="Paste the resume text you want reviewed"
              placeholderTextColor={tokens.color.muted}
              style={uiStyles.input}
            />
          </Card>
        ) : null}

        <Card>
          <View style={styles.inputHeading}>
            <Text style={uiStyles.sectionTitle}>Job description</Text>
            <Text style={styles.count}>{codePointLength(jobDescription).toLocaleString()} / {MAX_JOB_DESCRIPTION_CODE_POINTS.toLocaleString()}</Text>
          </View>
          <Text style={uiStyles.muted}>Optional. Add it only when you want a keyword comparison.</Text>
          <TextInput
            accessibilityLabel="Optional job description"
            multiline
            value={jobDescription}
            onChangeText={setJobDescription}
            editable={!working && state.status !== 'analyzing'}
            placeholder="Paste a job description"
            placeholderTextColor={tokens.color.muted}
            style={[uiStyles.input, styles.jobInput]}
          />
        </Card>

        <Card style={styles.privacyCard}>
          <Text style={styles.privacyMark}>Private handling</Text>
          <Text style={uiStyles.body}>Your input stays in memory except for a temporary, app-owned PDF copy. Reports save only when you choose Save locally.</Text>
        </Card>

        {localError !== null ? <Text accessibilityRole="alert" style={styles.error}>{localError}</Text> : null}
        {!scanRequired ? (
          <AnalysisStatus
            state={state}
            onCancel={() => { void commands.cancel(); }}
            onRetry={() => { void commands.analyze(); }}
            onRecoverPrivacy={() => { void commands.recoverPrivacyCleanup(); }}
          />
        ) : null}
        {state.status !== 'analyzing' && (!scanRequired || reviewedVision) && visionDraft === null ? (
          <AppButton
            label="Analyze resume"
            onPress={() => { void analyze(); }}
            disabled={working || state.privacyReadiness !== 'ready'}
          />
        ) : null}
      </Screen>
      <ConsentSheet
        visible={state.status === 'consentRequired'}
        busy={working}
        onAgree={() => { void commands.grantConsent(); }}
        onDecline={() => { void commands.declineConsent(); }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  hero: { rowGap: 10 },
  heroCopy: { color: tokens.color.muted, fontSize: 17, lineHeight: 25 },
  inputHeading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  count: { color: tokens.color.muted, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  jobInput: { minHeight: 96 },
  privacyCard: { borderColor: tokens.color.accent },
  scanCard: { borderColor: tokens.color.accent },
  visionInput: { minHeight: 220 },
  privacyMark: { color: tokens.color.accent, fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
  error: { color: tokens.color.warning, fontSize: 15, lineHeight: 22 },
});
