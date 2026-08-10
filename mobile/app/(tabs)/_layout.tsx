import { Tabs } from 'expo-router';

import { tokens } from '../../src/theme/tokens';

export function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.color.accent,
        tabBarInactiveTintColor: tokens.color.muted,
        tabBarStyle: { backgroundColor: tokens.color.surface },
        tabBarItemStyle: { minHeight: tokens.target.minimum },
      }}>
      <Tabs.Screen
        name="index"
        options={{ title: 'Analyze', tabBarAccessibilityLabel: 'Analyze' }}
      />
      <Tabs.Screen
        name="history"
        options={{ title: 'History', tabBarAccessibilityLabel: 'History' }}
      />
      <Tabs.Screen
        name="workspace"
        options={{ title: 'Workspace', tabBarAccessibilityLabel: 'Workspace' }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarAccessibilityLabel: 'Settings' }}
      />
    </Tabs>
  );
}

export default TabsLayout;
