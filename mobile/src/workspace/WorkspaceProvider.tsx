import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

import {
  WORKSPACE_DATABASE_IDENTITY,
  WorkspaceRepository,
  type WorkspaceRepositoryPort,
} from './workspaceRepository';

export type WorkspaceDataState =
  | Readonly<{ status: 'loading'; repository: null }>
  | Readonly<{ status: 'ready'; repository: WorkspaceRepositoryPort }>
  | Readonly<{ status: 'blocked'; repository: null }>;

const WorkspaceDataContext = createContext<WorkspaceDataState | undefined>(undefined);

type OwnedLifecycle = (priorClosed: boolean) => Promise<boolean>;

export interface WorkspaceLifecycleCoordinator {
  coordinate(databaseIdentity: string, lifecycle: OwnedLifecycle): Promise<boolean>;
}

class ProcessWorkspaceLifecycleCoordinator implements WorkspaceLifecycleCoordinator {
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

export function createWorkspaceLifecycleCoordinator(): WorkspaceLifecycleCoordinator {
  return new ProcessWorkspaceLifecycleCoordinator();
}

const PROCESS_WORKSPACE_LIFECYCLE = createWorkspaceLifecycleCoordinator();

export function WorkspaceProvider({
  children,
  createRepository = () => new WorkspaceRepository(),
  databaseIdentity = WORKSPACE_DATABASE_IDENTITY,
  lifecycleCoordinator = PROCESS_WORKSPACE_LIFECYCLE,
}: Readonly<{
  children?: React.ReactNode;
  createRepository?: () => WorkspaceRepositoryPort;
  databaseIdentity?: string;
  lifecycleCoordinator?: WorkspaceLifecycleCoordinator;
}>) {
  const factory = useRef(createRepository);
  const identity = useRef(databaseIdentity);
  const coordinator = useRef(lifecycleCoordinator);
  const [state, setState] = useState<WorkspaceDataState>({ status: 'loading', repository: null });

  useEffect(() => {
    let active = true;
    let dispose!: () => void;
    const disposed = new Promise<void>(resolve => { dispose = resolve; });
    const close = async (repository: WorkspaceRepositoryPort): Promise<boolean> => {
      try {
        await repository.close();
        return true;
      } catch {
        return false;
      }
    };
    const own = async (priorClosed: boolean): Promise<boolean> => {
      if (!priorClosed) {
        if (active) setState({ status: 'blocked', repository: null });
        return false;
      }
      let repository: WorkspaceRepositoryPort;
      try {
        repository = factory.current();
      } catch {
        if (active) setState({ status: 'blocked', repository: null });
        return true;
      }
      if (repository.databaseIdentity !== identity.current) {
        if (active) setState({ status: 'blocked', repository: null });
        return close(repository);
      }
      try {
        await repository.initialize();
      } catch {
        if (active) setState({ status: 'blocked', repository: null });
        return close(repository);
      }
      if (!active) return close(repository);
      setState({ status: 'ready', repository });
      await disposed;
      return close(repository);
    };
    void coordinator.current.coordinate(identity.current, own);
    return () => {
      active = false;
      dispose();
    };
  }, []);

  return (
    <WorkspaceDataContext.Provider value={state}>
      {children}
    </WorkspaceDataContext.Provider>
  );
}

export function useWorkspaceData(): WorkspaceDataState {
  const value = useContext(WorkspaceDataContext);
  if (value === undefined) throw new Error('useWorkspaceData requires WorkspaceProvider.');
  return value;
}
