import { Stack } from 'expo-router';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnalysisProvider } from '../src/analysis/AnalysisProvider';
import { AppControllerRoot } from '../src/controllers/AppController';
import { createRuntimeComposition } from '../src/controllers/runtime';
import { DataProvider } from '../src/storage/DataProvider';
import { tokens } from '../src/theme/tokens';

export default function RootLayout() {
  const [runtime] = useState(createRuntimeComposition);
  return (
    <SafeAreaProvider>
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
            </Stack>
          </AppControllerRoot>
        </AnalysisProvider>
      </DataProvider>
    </SafeAreaProvider>
  );
}
