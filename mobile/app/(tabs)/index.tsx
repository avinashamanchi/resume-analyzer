import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAppController } from '../../src/controllers/AppController';
import { AnalysisStatus } from '../../src/components/AnalysisStatus';
import { ConsentSheet } from '../../src/components/ConsentSheet';
import { AppButton, Card, Eyebrow, Screen, Title, uiStyles } from '../../src/components/primitives';
import { SourcePicker, type SourceMode } from '../../src/components/SourcePicker';
import { createPastedTextSource } from '../../src/documents/documentSource';
import { codePointLength, MAX_JOB_DESCRIPTION_CODE_POINTS, MAX_RESUME_CODE_POINTS } from '../../src/domain/limits';
import { tokens } from '../../src/theme/tokens';

const INPUT_ERROR = 'Check the resume and job-description limits before analyzing.';

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
  const priorGeneration = useRef(state.generation);
  const priorLifecycleEpoch = useRef(state.lifecycleEpoch);
  const operationEpoch = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationEpoch.current += 1;
    };
  }, []);

  useEffect(() => {
    if (state.lifecycleEpoch !== priorLifecycleEpoch.current) {
      operationEpoch.current += 1;
      setBusy(false);
    }
    priorLifecycleEpoch.current = state.lifecycleEpoch;
  }, [state.lifecycleEpoch]);

  const beginOperation = () => {
    operationEpoch.current += 1;
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
    }
    priorGeneration.current = state.generation;
  }, [state.generation, state.jobDescription, state.source, state.status]);

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
    if (next === mode || busy || state.status === 'analyzing') return;
    const epoch = beginOperation();
    setBusy(true);
    setLocalError(null);
    await commands.reset();
    if (!operationIsCurrent(epoch)) return;
    setPdfDisplay(null);
    setPasteText('');
    setJobDescription('');
    setMode(next);
    setBusy(false);
  };

  const choosePdf = async () => {
    if (busy) return;
    const epoch = beginOperation();
    setBusy(true);
    setLocalError(null);
    try {
      const picked = await actions.pickPdfForDisplay();
      if (operationIsCurrent(epoch) && picked !== null) {
        setPdfDisplay(picked);
      }
    } catch {
      if (operationIsCurrent(epoch)) setLocalError('The PDF could not be selected safely.');
    } finally {
      if (operationIsCurrent(epoch)) setBusy(false);
    }
  };

  const analyze = async () => {
    if (busy || state.status === 'analyzing') return;
    const epoch = beginOperation();
    setBusy(true);
    setLocalError(null);
    try {
      if (mode === 'paste') {
        const sourceReceipt = await commands.selectSource(createPastedTextSource(pasteText));
        if (!operationIsCurrent(epoch)) return;
        if (!sourceReceipt.committed) throw new Error(INPUT_ERROR);
      } else if (state.source?.kind !== 'pdf') {
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

  const working = busy || state.mutation !== 'none';
  const displayName = pdfDisplay !== null &&
    state.source?.kind === 'pdf' &&
    state.source.lease === pdfDisplay.sourceIdentity
    ? pdfDisplay.displayName
    : null;
  return (
    <>
      <Screen>
        <View style={styles.hero}>
          <Eyebrow>Resume.AI · private by default</Eyebrow>
          <Title>A clearer read on your resume.</Title>
          <Text style={styles.heroCopy}>
            Review structure, evidence, readability, and job-language alignment. Results are guidance—not an ATS verdict or hiring prediction.
          </Text>
        </View>

        <SourcePicker
          mode={mode}
          displayName={displayName}
          busy={working || state.status === 'analyzing'}
          onModeChange={next => { void changeMode(next); }}
          onChoosePdf={() => { void choosePdf(); }}
        />

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
        <AnalysisStatus state={state} onCancel={() => { void commands.cancel(); }} onRetry={() => { void commands.analyze(); }} />
        {state.status !== 'analyzing' ? (
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
  privacyMark: { color: tokens.color.accent, fontSize: 13, lineHeight: 18, fontWeight: '800', letterSpacing: 0.7, textTransform: 'uppercase' },
  error: { color: tokens.color.warning, fontSize: 15, lineHeight: 22 },
});
