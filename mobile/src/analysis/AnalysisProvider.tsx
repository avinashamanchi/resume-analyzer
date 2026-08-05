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
    void coordinator.initialize().catch(() => undefined);
    const subscription = appState.addEventListener('change', nextState => {
      void coordinator.handleAppState(nextState).catch(() => undefined);
    });
    return () => {
      subscription.remove();
      void coordinator.dispose().catch(() => undefined);
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
