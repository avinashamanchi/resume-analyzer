import { Stack } from 'expo-router';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnalysisProvider } from '../src/analysis/AnalysisProvider';
import { BillingProvider } from '../src/billing/BillingProvider';
import { AppControllerRoot } from '../src/controllers/AppController';
import { createRuntimeComposition } from '../src/controllers/runtime';
import { DataProvider } from '../src/storage/DataProvider';
import { tokens } from '../src/theme/tokens';

export default function RootLayout() {
  const [runtime] = useState(createRuntimeComposition);
  return (
    <SafeAreaProvider>
      <BillingProvider service={runtime.billingService}>
        <DataProvider createRepository={runtime.createRepository}>
          <AnalysisProvider coordinator={runtime.coordinator}>
            <AppControllerRoot services={runtime.services}>
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
              </Stack>
            </AppControllerRoot>
          </AnalysisProvider>
        </DataProvider>
      </BillingProvider>
    </SafeAreaProvider>
  );
}
