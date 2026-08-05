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
  const [state, setState] = useState<ReportDataState>({ status: 'loading', repository: null });

  useEffect(() => {
    let active = true;
    let repository: ReportRepositoryPort | null = null;
    setState({ status: 'loading', repository: null });

    try {
      repository = factory.current();
    } catch {
      setState({ status: 'blocked', repository: null });
      return () => { active = false; };
    }

    const ownedRepository = repository;
    void ownedRepository.initialize().then(
      () => {
        if (active) setState({ status: 'ready', repository: ownedRepository });
      },
      () => {
        if (active) setState({ status: 'blocked', repository: null });
        void ownedRepository.close().catch(() => undefined);
      },
    );

    return () => {
      active = false;
      void ownedRepository.close().catch(() => undefined);
    };
  }, []);

  return React.createElement(ReportDataContext.Provider, { value: state }, children);
}

export function useReportData(): ReportDataState {
  const value = useContext(ReportDataContext);
  if (value === undefined) throw new Error('useReportData must be used within DataProvider.');
  return value;
}
