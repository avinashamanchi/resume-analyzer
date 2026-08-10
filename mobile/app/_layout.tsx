import { Stack } from 'expo-router';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnalysisProvider } from '../src/analysis/AnalysisProvider';
import { BillingProvider } from '../src/billing/BillingProvider';
import { AppControllerRoot } from '../src/controllers/AppController';
import { createRuntimeComposition } from '../src/controllers/runtime';
import { LocalErasureProvider } from '../src/privacy/LocalErasureProvider';
import { DataProvider } from '../src/storage/DataProvider';
import { tokens } from '../src/theme/tokens';
import { WorkspaceProvider } from '../src/workspace/WorkspaceProvider';

export default function RootLayout() {
  const [runtime] = useState(createRuntimeComposition);
  return (
    <SafeAreaProvider>
      <BillingProvider service={runtime.billingService}>
        <WorkspaceProvider createRepository={runtime.createWorkspaceRepository}>
          <DataProvider createRepository={runtime.createRepository}>
            <AnalysisProvider coordinator={runtime.coordinator}>
              <AppControllerRoot services={runtime.services}>
                <LocalErasureProvider>
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      contentStyle: { backgroundColor: tokens.color.background },
                    }}>
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen name="results/[analysisId]" />
                    <Stack.Screen name="privacy" />
                    <Stack.Screen name="support" />
                    <Stack.Screen name="terms" />
                    <Stack.Screen name="upgrade" />
                    <Stack.Screen name="versions/index" />
                    <Stack.Screen name="versions/[versionId]" />
                    <Stack.Screen name="jobs/index" />
                    <Stack.Screen name="jobs/[jobId]" />
                    <Stack.Screen name="compare" />
                  </Stack>
                </LocalErasureProvider>
              </AppControllerRoot>
            </AnalysisProvider>
          </DataProvider>
        </WorkspaceProvider>
      </BillingProvider>
    </SafeAreaProvider>
  );
}
