import type { AnalysisResponse } from '../domain/contracts';
import type { StableErrorCategory } from '../domain/errors';
import type { ResumeSource } from '../documents/documentSource';

export type AnalysisStatus =
  | 'idle'
  | 'ready'
  | 'consentRequired'
  | 'analyzing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type AnalysisErrorCategory =
  | StableErrorCategory
  | 'privacy'
  | 'consent_storage';

export type AnalysisMutation =
  | 'none'
  | 'selecting'
  | 'editing'
  | 'resetting'
  | 'consent';

export type PublicAnalysisError = Readonly<{
  category: AnalysisErrorCategory;
  message: string;
  retryable: boolean;
  code?: string;
  requestId?: string;
}>;

export type AnalysisState = Readonly<{
  status: AnalysisStatus;
  privacyReadiness: 'checking' | 'ready' | 'blocked';
  source: ResumeSource | null;
  jobDescription: string;
  result: AnalysisResponse | null;
  error: PublicAnalysisError | null;
  generation: number;
  activation: number | null;
  cleanupPending: boolean;
  mutation: AnalysisMutation;
  lifecycleEpoch: number;
}>;

export type AnalysisEvent =
  | Readonly<{ type: 'initializationReady' }>
  | Readonly<{ type: 'initializationFailed'; error: PublicAnalysisError }>
  | Readonly<{ type: 'lifecycleInvalidated'; lifecycleEpoch: number }>
  | Readonly<{ type: 'generationAdvanced'; generation: number }>
  | Readonly<{
      type: 'mutationStarted';
      generation: number;
      mutation: Exclude<AnalysisMutation, 'none'>;
    }>
  | Readonly<{ type: 'sourceReady'; generation: number; source: ResumeSource }>
  | Readonly<{
      type: 'jobUpdated';
      generation: number;
      jobDescription: string;
      consumeSource?: boolean;
    }>
  | Readonly<{ type: 'consentRequired'; generation: number }>
  | Readonly<{
      type: 'consentDeclined';
      generation: number;
      consumeSource: boolean;
    }>
  | Readonly<{ type: 'analysisStarted'; generation: number; activation: number }>
  | Readonly<{
      type: 'analysisSucceeded';
      generation: number;
      activation: number;
      result: AnalysisResponse;
      consumeSource: boolean;
    }>
  | Readonly<{
      type: 'analysisFailed';
      generation: number;
      activation?: number;
      error: PublicAnalysisError;
      consumeSource: boolean;
      cleanupPending?: boolean;
    }>
  | Readonly<{
      type: 'analysisCancelled';
      generation: number;
      activation?: number;
      consumeSource: boolean;
    }>
  | Readonly<{ type: 'reset'; generation: number }>;

export function createInitialAnalysisState(): AnalysisState {
  return {
    status: 'idle',
    privacyReadiness: 'checking',
    source: null,
    jobDescription: '',
    result: null,
    error: null,
    generation: 0,
    activation: null,
    cleanupPending: false,
    mutation: 'none',
    lifecycleEpoch: 0,
  };
}

function terminalMatches(
  state: AnalysisState,
  event: { generation: number; activation?: number },
): boolean {
  if (event.generation !== state.generation) return false;
  if (event.activation === undefined) return state.status !== 'analyzing';
  return state.status === 'analyzing' && state.activation === event.activation;
}

export function analysisReducer(state: AnalysisState, event: AnalysisEvent): AnalysisState {
  switch (event.type) {
    case 'initializationReady':
      if (state.privacyReadiness !== 'checking') return state;
      return { ...state, privacyReadiness: 'ready' };
    case 'initializationFailed':
      if (state.privacyReadiness !== 'checking') return state;
      return {
        ...state,
        status: 'failed',
        privacyReadiness: 'blocked',
        error: event.error,
        cleanupPending: true,
        mutation: 'none',
      };
    case 'lifecycleInvalidated':
      if (event.lifecycleEpoch <= state.lifecycleEpoch) return state;
      return { ...state, lifecycleEpoch: event.lifecycleEpoch };
    case 'generationAdvanced':
      if (event.generation <= state.generation) return state;
      return {
        ...state,
        status: state.source === null ? 'idle' : 'ready',
        result: null,
        error: null,
        generation: event.generation,
        activation: null,
        mutation: 'none',
      };
    case 'mutationStarted':
      if (event.generation <= state.generation) return state;
      return {
        ...state,
        status: 'idle',
        result: null,
        error: null,
        generation: event.generation,
        activation: null,
        mutation: event.mutation,
      };
    case 'sourceReady':
      if (
        state.privacyReadiness !== 'ready' ||
        event.generation !== state.generation ||
        state.mutation !== 'selecting'
      ) return state;
      return {
        ...state,
        status: 'ready',
        source: event.source,
        result: null,
        error: null,
        activation: null,
        cleanupPending: false,
        mutation: 'none',
      };
    case 'jobUpdated':
      if (
        state.privacyReadiness !== 'ready' ||
        event.generation !== state.generation ||
        state.mutation !== 'editing'
      ) return state;
      return {
        ...state,
        status: state.source === null || event.consumeSource === true ? 'idle' : 'ready',
        source: event.consumeSource === true ? null : state.source,
        jobDescription: event.jobDescription,
        result: null,
        error: null,
        activation: null,
        cleanupPending: event.consumeSource === true ? false : state.cleanupPending,
        mutation: 'none',
      };
    case 'consentRequired':
      if (
        state.privacyReadiness !== 'ready' ||
        state.source === null ||
        event.generation !== state.generation ||
        state.status === 'analyzing'
      ) return state;
      return { ...state, status: 'consentRequired', result: null, error: null };
    case 'consentDeclined':
      if (event.generation !== state.generation || state.mutation !== 'consent') return state;
      return {
        ...state,
        status: event.consumeSource || state.source === null ? 'idle' : 'ready',
        source: event.consumeSource ? null : state.source,
        error: null,
        cleanupPending: false,
        mutation: 'none',
      };
    case 'analysisStarted':
      if (
        state.privacyReadiness !== 'ready' ||
        state.source === null ||
        event.generation !== state.generation ||
        state.mutation !== 'none' ||
        state.status === 'analyzing'
      ) return state;
      return {
        ...state,
        status: 'analyzing',
        result: null,
        error: null,
        activation: event.activation,
      };
    case 'analysisSucceeded':
      if (!terminalMatches(state, event)) return state;
      return {
        ...state,
        status: 'succeeded',
        source: event.consumeSource ? null : state.source,
        result: event.result,
        error: null,
        activation: null,
        cleanupPending: false,
        mutation: 'none',
      };
    case 'analysisFailed':
      if (!terminalMatches(state, event)) return state;
      return {
        ...state,
        status: 'failed',
        source: event.consumeSource ? null : state.source,
        result: null,
        error: event.error,
        activation: null,
        cleanupPending: event.cleanupPending === true,
        mutation: 'none',
      };
    case 'analysisCancelled':
      if (!terminalMatches(state, event)) return state;
      return {
        ...state,
        status: 'cancelled',
        source: event.consumeSource ? null : state.source,
        result: null,
        error: null,
        activation: null,
        cleanupPending: false,
        mutation: 'none',
      };
    case 'reset':
      if (event.generation !== state.generation || state.mutation !== 'resetting') return state;
      return {
        ...createInitialAnalysisState(),
        privacyReadiness: state.privacyReadiness,
        generation: event.generation,
        lifecycleEpoch: state.lifecycleEpoch,
      };
  }
}
