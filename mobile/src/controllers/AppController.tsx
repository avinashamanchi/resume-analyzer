import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAnalysis } from '../analysis/AnalysisProvider';
import type { AnalysisCommands } from '../analysis/analysisCoordinator';
import type { AnalysisState } from '../analysis/analysisReducer';
import type { AnalysisResponse } from '../domain/contracts';
import {
  DocumentSourceError,
  type PickedPdfForDisplay,
} from '../documents/documentSource';
import type { AbandonedCleanupReceipt } from '../documents/tempFileRegistry';
import { useReportData } from '../storage/DataProvider';
import type { DeleteReceipt, ReportRecord } from '../storage/reportRepository';

export type DisplayReport = ReportRecord | AnalysisResponse;

export type AppServices = Readonly<{
  documents: Readonly<{ pickPdfForDisplay(): Promise<PickedPdfForDisplay | null> }>;
  consent: Readonly<{ clear(): Promise<void> }>;
  cache: Readonly<{ cleanupAbandonedDetailed(): Promise<AbandonedCleanupReceipt> }>;
  shareText(text: string): Promise<void>;
  openSupport(): Promise<void>;
  serviceAvailable: boolean;
  appVersion: string;
}>;

export type AppActions = Readonly<{
  pickPdfForDisplay(signal: AbortSignal): Promise<Readonly<{
    sourceIdentity: symbol;
    sourceGeneration: number;
    displayName: string;
  }> | null>;
  resetConsent(): Promise<void>;
  cleanupCache(): Promise<Readonly<{ verified: boolean; deletedFiles: number }>>;
  shareSummary(result: AnalysisResponse): Promise<void>;
  openSupport(): Promise<void>;
  serviceAvailable: boolean;
  appVersion: string;
}>;

export type HistoryController = Readonly<{
  status: 'loading' | 'ready' | 'error' | 'blocked';
  reports: readonly ReportRecord[];
  error: string | null;
  load(): Promise<void>;
  saveCurrent(): Promise<ReportRecord | null>;
  get(id: string): Promise<DisplayReport | null>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<DeleteReceipt>;
}>;

export type AppControllerValue = Readonly<{
  actions: AppActions;
  analysis: Readonly<{ state: AnalysisState; commands: AnalysisCommands }>;
  history: HistoryController;
}>;

const AppControllerContext = createContext<AppControllerValue | null>(null);

export function AppControllerProvider({
  value,
  children,
}: Readonly<{ value: AppControllerValue; children: ReactNode }>) {
  return <AppControllerContext.Provider value={value}>{children}</AppControllerContext.Provider>;
}

export function useAppController(): AppControllerValue {
  const value = useContext(AppControllerContext);
  if (value === null) throw new Error('AppControllerProvider is required.');
  return value;
}

const HISTORY_ERROR = 'Local reports could not complete the operation.';

export function AppControllerRoot({
  services,
  children,
}: Readonly<{ services: AppServices; children: ReactNode }>) {
  const analysis = useAnalysis();
  const data = useReportData();
  const [reports, setReports] = useState<readonly ReportRecord[]>([]);
  const [status, setStatus] = useState<HistoryController['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const operationTail = useRef(Promise.resolve());

  const serialize = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = operationTail.current.then(operation, operation);
    operationTail.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const load = useCallback(async () => {
    if (data.status !== 'ready') {
      setStatus(data.status === 'blocked' ? 'blocked' : 'loading');
      return;
    }
    setStatus('loading');
    setError(null);
    await serialize(async () => {
      try {
        setReports(await data.repository.list());
        setStatus('ready');
      } catch {
        setError(HISTORY_ERROR);
        setStatus('error');
      }
    });
  }, [data, serialize]);

  useEffect(() => { void load(); }, [load]);

  const get = useCallback(async (id: string): Promise<DisplayReport | null> => {
    if (analysis.state.result?.analysisId === id) return analysis.state.result;
    if (data.status !== 'ready') return null;
    return serialize(async () => {
      try {
        return await data.repository.get(id);
      } catch {
        return null;
      }
    });
  }, [analysis.state.result, data, serialize]);

  const saveCurrent = useCallback(async (): Promise<ReportRecord | null> => {
    const result = analysis.state.result;
    if (result === null || data.status !== 'ready') return null;
    return serialize(async () => {
      const alreadySaved = reports.find(report => report.id === result.analysisId);
      if (alreadySaved !== undefined) return alreadySaved;
      try {
        const existing = await data.repository.get(result.analysisId);
        if (existing !== null) {
          setReports(current => current.some(item => item.id === existing.id)
            ? current
            : [existing, ...current]);
          return existing;
        }
        const saved = await data.repository.save({ result });
        setReports(current => [saved, ...current.filter(item => item.id !== saved.id)]);
        setStatus('ready');
        setError(null);
        return saved;
      } catch {
        setError(HISTORY_ERROR);
        return null;
      }
    });
  }, [analysis.state.result, data, reports, serialize]);

  const deleteReport = useCallback(async (id: string): Promise<boolean> => {
    if (data.status !== 'ready') return false;
    return serialize(async () => {
      try {
        const deleted = await data.repository.delete(id);
        if (deleted !== 1) return false;
        setReports(current => current.filter(report => report.id !== id));
        setError(null);
        return true;
      } catch {
        setError(HISTORY_ERROR);
        return false;
      }
    });
  }, [data, serialize]);

  const deleteAll = useCallback(async (): Promise<DeleteReceipt> => {
    if (data.status !== 'ready') throw new Error(HISTORY_ERROR);
    return serialize(async () => {
      try {
        const receipt = await data.repository.deleteAll();
        if (receipt.failures !== 0) throw new Error(HISTORY_ERROR);
        setReports([]);
        setError(null);
        setStatus('ready');
        return receipt;
      } catch {
        setError(HISTORY_ERROR);
        throw new Error(HISTORY_ERROR);
      }
    });
  }, [data, serialize]);

  const history = useMemo<HistoryController>(() => ({
    status,
    reports,
    error,
    load,
    saveCurrent,
    get,
    delete: deleteReport,
    deleteAll,
  }), [deleteAll, deleteReport, error, get, load, reports, saveCurrent, status]);

  const actions = useMemo<AppActions>(() => ({
    async pickPdfForDisplay(signal) {
      const authority = analysis.commands.beginPdfPick(signal);
      let picked: PickedPdfForDisplay | null;
      try {
        picked = await services.documents.pickPdfForDisplay();
      } catch (error) {
        if (
          error instanceof DocumentSourceError &&
          error.category === 'privacy' &&
          error.code === 'cache_cleanup_failed'
        ) {
          await analysis.commands.failPdfPick(authority, 'abandoned_cleanup_required');
        } else {
          await analysis.commands.completePdfPick(authority, null);
        }
        throw error;
      }
      const receipt = await analysis.commands.completePdfPick(authority, picked?.source ?? null);
      if (
        picked === null ||
        !receipt.committed ||
        receipt.sourceIdentity !== picked.source.lease
      ) return null;
      return {
        sourceIdentity: receipt.sourceIdentity,
        sourceGeneration: receipt.generation,
        displayName: picked.displayName,
      };
    },
    resetConsent: () => services.consent.clear(),
    async cleanupCache() {
      const result = await services.cache.cleanupAbandonedDetailed();
      return {
        verified: result.failed === 0 &&
          result.refused === 0 &&
          result.live === 0 &&
          result.attempted === result.deleted,
        deletedFiles: result.deletedFiles,
      };
    },
    shareSummary: result => services.shareText(
      `Resume.AI summary\n\n${result.score.readinessScore}/100 — ${result.score.label}\n${result.feedback.summary}\n\nAI-generated guidance; not an ATS or hiring outcome.`,
    ),
    openSupport: () => services.openSupport(),
    serviceAvailable: services.serviceAvailable,
    appVersion: services.appVersion,
  }), [analysis.commands, services]);

  const value = useMemo<AppControllerValue>(
    () => ({ actions, analysis, history }),
    [actions, analysis, history],
  );
  return <AppControllerProvider value={value}>{children}</AppControllerProvider>;
}
