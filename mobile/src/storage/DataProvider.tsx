import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

import {
  REPORT_DATABASE_IDENTITY,
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

type OwnedLifecycle = (priorClosed: boolean) => Promise<boolean>;

export interface ReportLifecycleCoordinator {
  coordinate(databaseIdentity: string, lifecycle: OwnedLifecycle): Promise<boolean>;
}

class ProcessReportLifecycleCoordinator implements ReportLifecycleCoordinator {
  private readonly handoffs = new Map<string, Promise<boolean>>();

  coordinate(databaseIdentity: string, lifecycle: OwnedLifecycle): Promise<boolean> {
    const prior = this.handoffs.get(databaseIdentity);
    const current = (prior ?? Promise.resolve(true))
      .then(lifecycle, () => lifecycle(false))
      .catch(() => false);
    this.handoffs.set(databaseIdentity, current);
    void current.then(closed => {
      if (closed && this.handoffs.get(databaseIdentity) === current) {
        this.handoffs.delete(databaseIdentity);
      }
    });
    return current;
  }
}

export function createReportLifecycleCoordinator(): ReportLifecycleCoordinator {
  return new ProcessReportLifecycleCoordinator();
}

const PROCESS_REPORT_LIFECYCLE_COORDINATOR = createReportLifecycleCoordinator();

export type DataProviderProps = Readonly<{
  children?: React.ReactNode;
  createRepository?: () => ReportRepositoryPort;
  databaseIdentity?: string;
  lifecycleCoordinator?: ReportLifecycleCoordinator;
}>;

export function DataProvider({
  children,
  createRepository = defaultRepositoryFactory,
  databaseIdentity = REPORT_DATABASE_IDENTITY,
  lifecycleCoordinator = PROCESS_REPORT_LIFECYCLE_COORDINATOR,
}: DataProviderProps) {
  const factory = useRef(createRepository);
  const identity = useRef(databaseIdentity);
  const coordinator = useRef(lifecycleCoordinator);
  const [state, setState] = useState<ReportDataState>({ status: 'loading', repository: null });

  useEffect(() => {
    let active = true;
    let dispose!: () => void;
    const disposed = new Promise<void>(resolve => { dispose = resolve; });
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
        return true;
      }

      if (repository.databaseIdentity !== identity.current) {
        if (active) setState({ status: 'blocked', repository: null });
        return closeOwned(repository);
      }

      try {
        await repository.initialize();
      } catch {
        if (active) setState({ status: 'blocked', repository: null });
        return closeOwned(repository);
      }

      if (!active) return closeOwned(repository);
      setState({ status: 'ready', repository });
      await disposed;
      return closeOwned(repository);
    };
    void coordinator.current.coordinate(identity.current, ownLifecycle);

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
