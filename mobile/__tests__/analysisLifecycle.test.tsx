import { act, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import validFixture from '../../contracts/fixtures/analysis-valid.json';

import { AnalysisCoordinator } from '../src/analysis/analysisCoordinator';
import {
  AnalysisProvider,
  useAnalysis,
  type AnalysisAppStatePort,
} from '../src/analysis/AnalysisProvider';
import type { AnalysisResponse } from '../src/domain/contracts';
import type { CleanupReceipt } from '../src/documents/tempFileRegistry';

const CLEAN: CleanupReceipt = { attempted: 0, deleted: 0, failed: 0, refused: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(onResolve => { resolve = onResolve; });
  return { promise, resolve };
}

function providerHarness() {
  const api = {
    analyze: jest.fn(async () => validFixture as AnalysisResponse),
  };
  const consentStore = {
    hasCurrentConsent: jest.fn(async () => true),
    grant: jest.fn(async () => undefined),
  };
  const tempFiles = {
    cleanupAbandoned: jest.fn(async () => CLEAN),
    cleanupRequest: jest.fn(async () => CLEAN),
  };
  const coordinator = new AnalysisCoordinator({ api, consentStore, tempFiles });
  return { api, consentStore, coordinator, tempFiles };
}

function Probe({ route }: { route: string }) {
  const { state, commands } = useAnalysis();
  return (
    <>
      <Text testID="route">{route}</Text>
      <Text testID="status">{state.status}</Text>
      <Text testID="draft">{state.source?.kind === 'text' ? state.source.text : ''}</Text>
      <Text
        testID="select"
        onPress={() => { void commands.selectSource({ kind: 'text', text: 'private draft' }); }}
      >
        Select
      </Text>
    </>
  );
}

describe('AnalysisProvider in-memory lifecycle', () => {
  it('keeps an unsent paste draft in memory while navigation content changes', async () => {
    const { consentStore, coordinator } = providerHarness();
    const view = await render(
      <AnalysisProvider coordinator={coordinator}>
        <Probe route="Analyze" />
      </AnalysisProvider>,
    );
    await act(async () => { await coordinator.initialize(); });
    await act(async () => {
      await coordinator.commands.selectSource({ kind: 'text', text: 'private draft' });
    });

    await view.rerender(
      <AnalysisProvider coordinator={coordinator}>
        <Probe route="History" />
      </AnalysisProvider>,
    );
    await view.rerender(
      <AnalysisProvider coordinator={coordinator}>
        <Probe route="Analyze" />
      </AnalysisProvider>,
    );

    expect(view.getByTestId('route').props.children).toBe('Analyze');
    expect(view.getByTestId('draft').props.children).toBe('private draft');
    expect(consentStore.grant).not.toHaveBeenCalled();
  });

  it('wires background cancellation but active foreground never retries', async () => {
    const pending = deferred<AnalysisResponse>();
    const listeners = new Set<(state: string) => void>();
    const appState: AnalysisAppStatePort = {
      addEventListener: (_event, listener) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    };
    const { api, coordinator } = providerHarness();
    api.analyze.mockReturnValueOnce(pending.promise);
    const view = await render(
      <AnalysisProvider coordinator={coordinator} appState={appState}>
        <Probe route="Analyze" />
      </AnalysisProvider>,
    );
    await act(async () => {
      await coordinator.initialize();
      await coordinator.commands.selectSource({ kind: 'text', text: 'private draft' });
      void coordinator.commands.analyze();
      await Promise.resolve();
    });

    await act(async () => {
      for (const listener of listeners) listener('background');
      await Promise.resolve();
    });
    await act(async () => {
      for (const listener of listeners) listener('active');
      await Promise.resolve();
    });

    expect(api.analyze).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('status').props.children).toBe('cancelled');
    await view.unmount();
  });

  it('provider unmount catches disposal while the explicit disposal promise awaits cleanup', async () => {
    const cleanup = deferred<CleanupReceipt>();
    const privateUnhandled: unknown[] = [];
    const unhandled = (reason: unknown) => privateUnhandled.push(reason);
    process.on('unhandledRejection', unhandled);
    const { coordinator, tempFiles } = providerHarness();
    tempFiles.cleanupRequest.mockReturnValueOnce(cleanup.promise);
    await coordinator.initialize();
    await coordinator.commands.selectSource({
      kind: 'pdf',
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      uri: 'file:///app/cache/resume-ai-v1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111.pdf',
      size: 1_024,
    });
    const view = await render(
      <AnalysisProvider coordinator={coordinator}>
        <Probe route="Analyze" />
      </AnalysisProvider>,
    );

    await view.unmount();
    cleanup.resolve({ attempted: 1, deleted: 1, failed: 0, refused: 0 });
    await act(async () => { await coordinator.dispose(); });

    expect(privateUnhandled).toEqual([]);
    process.removeListener('unhandledRejection', unhandled);
  });
});
