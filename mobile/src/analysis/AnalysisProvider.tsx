import React, {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';

import {
  AnalysisCoordinator,
  type AnalysisCommands,
} from './analysisCoordinator';
import type { AnalysisState } from './analysisReducer';

export type AnalysisAppStatePort = Readonly<{
  addEventListener(
    event: 'change',
    listener: (state: string) => void,
  ): { remove(): void };
}>;

type AnalysisContextValue = Readonly<{
  state: AnalysisState;
  commands: AnalysisCommands;
}>;

type AnalysisProviderProps = Readonly<{
  coordinator: AnalysisCoordinator;
  appState?: AnalysisAppStatePort;
  children: ReactNode;
}>;

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

type ProviderOwnership = {
  mounts: number;
  revision: number;
  disposing: boolean;
};

const providerOwnership = new WeakMap<AnalysisCoordinator, ProviderOwnership>();

function retainCoordinator(coordinator: AnalysisCoordinator): () => void {
  const ownership = providerOwnership.get(coordinator) ?? {
    mounts: 0,
    revision: 0,
    disposing: false,
  };
  ownership.mounts += 1;
  ownership.revision += 1;
  providerOwnership.set(coordinator, ownership);

  return () => {
    ownership.mounts = Math.max(0, ownership.mounts - 1);
    const releaseRevision = ++ownership.revision;
    queueMicrotask(() => {
      if (
        ownership.mounts !== 0 ||
        ownership.revision !== releaseRevision ||
        ownership.disposing
      ) return;
      ownership.disposing = true;
      void coordinator.dispose().catch(() => undefined);
    });
  };
}

const nativeAppState: AnalysisAppStatePort = {
  addEventListener(event, listener) {
    return AppState.addEventListener(event, listener);
  },
};

export function AnalysisProvider({
  coordinator,
  appState = nativeAppState,
  children,
}: AnalysisProviderProps) {
  const state = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getState,
    coordinator.getState,
  );

  useEffect(() => {
    const releaseCoordinator = retainCoordinator(coordinator);
    void coordinator.initialize().catch(() => undefined);
    const subscription = appState.addEventListener('change', nextState => {
      void coordinator.handleAppState(nextState).catch(() => undefined);
    });
    return () => {
      subscription.remove();
      releaseCoordinator();
    };
  }, [appState, coordinator]);

  const value = useMemo<AnalysisContextValue>(
    () => ({ state, commands: coordinator.commands }),
    [coordinator, state],
  );
  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}

export function useAnalysis(): AnalysisContextValue {
  const value = useContext(AnalysisContext);
  if (value === null) throw new Error('AnalysisProvider is required.');
  return value;
}
