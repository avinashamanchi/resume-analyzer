import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

import {
  ReportRepository,
  type ReportRepositoryPort,
} from './reportRepository';

export type ReportDataState =
  | Readonly<{ status: 'loading'; repository: null }>
  | Readonly<{ status: 'ready'; repository: ReportRepositoryPort }>
  | Readonly<{ status: 'blocked'; repository: null }>;

const ReportDataContext = createContext<ReportDataState | undefined>(undefined);

function defaultRepositoryFactory(): ReportRepositoryPort {
  return new ReportRepository();
}

export type DataProviderProps = Readonly<{
  children?: React.ReactNode;
  createRepository?: () => ReportRepositoryPort;
}>;

export function DataProvider({
  children,
  createRepository = defaultRepositoryFactory,
}: DataProviderProps) {
  const factory = useRef(createRepository);
  const handoff = useRef<Promise<boolean> | null>(null);
  const [state, setState] = useState<ReportDataState>({ status: 'loading', repository: null });

  useEffect(() => {
    let active = true;
    let dispose!: () => void;
    const disposed = new Promise<void>(resolve => { dispose = resolve; });
    setState({ status: 'loading', repository: null });

    const prior = handoff.current;
    const closeOwned = async (repository: ReportRepositoryPort): Promise<boolean> => {
      try {
        await repository.close();
        return true;
      } catch {
        return false;
      }
    };
    const ownLifecycle = async (priorClosed: boolean): Promise<boolean> => {
      if (!priorClosed) {
        if (active) setState({ status: 'blocked', repository: null });
        return false;
      }

      let repository: ReportRepositoryPort;
      try {
        repository = factory.current();
      } catch {
        if (active) setState({ status: 'blocked', repository: null });
        return false;
      }

      try {
        await repository.initialize();
      } catch {
        if (active) setState({ status: 'blocked', repository: null });
        await closeOwned(repository);
        return false;
      }

      if (!active) return closeOwned(repository);
      setState({ status: 'ready', repository });
      await disposed;
      return closeOwned(repository);
    };
    const lifecycle = prior === null
      ? ownLifecycle(true)
      : prior.then(ownLifecycle, () => ownLifecycle(false));
    handoff.current = lifecycle.catch(() => false);

    return () => {
      active = false;
      dispose();
    };
  }, []);

  return React.createElement(ReportDataContext.Provider, { value: state }, children);
}

export function useReportData(): ReportDataState {
  const value = useContext(ReportDataContext);
  if (value === undefined) throw new Error('useReportData must be used within DataProvider.');
  return value;
}
