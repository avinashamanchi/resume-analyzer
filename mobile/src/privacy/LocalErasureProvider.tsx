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

import { useAppController } from '../controllers/AppController';
import { useWorkspaceData, type WorkspaceDataState } from '../workspace/WorkspaceProvider';
import {
  LocalErasureCoordinator,
  createSecureLocalErasureJournal,
  type LocalErasureJournalPort,
} from './localErasure';

export type LocalErasureContextValue = Readonly<{
  status: 'loading' | 'ready' | 'blocked';
  busy: boolean;
  message: string | null;
  eraseAll(): Promise<boolean>;
}>;

const LocalErasureContext = createContext<LocalErasureContextValue | undefined>(undefined);

export function LocalErasureProvider({
  children,
  journal,
}: Readonly<{
  children: ReactNode;
  journal?: LocalErasureJournalPort;
}>) {
  const controller = useAppController();
  const workspace = useWorkspaceData();
  const controllerRef = useRef(controller);
  const workspaceRef = useRef<WorkspaceDataState>(workspace);
  controllerRef.current = controller;
  workspaceRef.current = workspace;

  const journalRef = useRef<LocalErasureJournalPort | null>(null);
  journalRef.current ??= journal ?? createSecureLocalErasureJournal();
  const coordinatorRef = useRef<LocalErasureCoordinator | null>(null);
  coordinatorRef.current ??= new LocalErasureCoordinator({
    journal: journalRef.current,
    resetSession: () => controllerRef.current.analysis.commands.reset(),
    deleteReports: async () => {
      const receipt = await controllerRef.current.history.deleteAll();
      if (receipt.failures !== 0) throw new Error('report erasure was not verified');
    },
    deleteWorkspace: async () => {
      const current = workspaceRef.current;
      if (current.status !== 'ready') throw new Error('workspace is unavailable');
      const receipt = await current.repository.deleteAll();
      if (receipt.failures !== 0) throw new Error('workspace erasure was not verified');
    },
  });

  const [status, setStatus] = useState<LocalErasureContextValue['status']>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (workspace.status === 'blocked' || controller.history.status === 'blocked' || controller.history.status === 'error') {
      setStatus('blocked');
      setBusy(false);
      setMessage('All local data cannot be verified as cleared until every local store opens safely.');
      return () => { active = false; };
    }
    if (workspace.status !== 'ready' || controller.history.status !== 'ready') {
      setStatus('loading');
      setBusy(true);
      return () => { active = false; };
    }

    setBusy(true);
    void coordinatorRef.current!.resume().then(() => {
      if (!active) return;
      setStatus('ready');
      setBusy(false);
      setMessage(null);
    }).catch(() => {
      if (!active) return;
      setStatus('blocked');
      setBusy(false);
      setMessage('A pending local deletion could not be completed. Keep the app open and try Delete All again.');
    });
    return () => { active = false; };
  }, [controller.history.status, workspace.status]);

  const eraseAll = useCallback(async () => {
    if (
      busy ||
      workspaceRef.current.status !== 'ready' ||
      controllerRef.current.history.status !== 'ready'
    ) return false;
    setBusy(true);
    setMessage(null);
    try {
      await coordinatorRef.current!.eraseAll();
      setStatus('ready');
      setMessage('All active local data stores were verified as cleared.');
      return true;
    } catch {
      setStatus('blocked');
      setMessage('All local data could not be verified as cleared. Keep the app open and try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const value = useMemo<LocalErasureContextValue>(() => ({
    status,
    busy,
    message,
    eraseAll,
  }), [busy, eraseAll, message, status]);

  return <LocalErasureContext.Provider value={value}>{children}</LocalErasureContext.Provider>;
}

export function useLocalErasure(): LocalErasureContextValue {
  const value = useContext(LocalErasureContext);
  if (value === undefined) throw new Error('useLocalErasure requires LocalErasureProvider.');
  return value;
}
