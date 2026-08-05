import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { TabsLayout } from '../app/(tabs)/_layout';
import { tokens } from '../src/theme/tokens';

const easConfig = require('../eas.json');
const packageManifest = require('../package.json');

jest.mock('expo-router', () => {
  const React = require('react');
  const { Pressable, View } = require('react-native');

  function Tabs({ children }: { children: ReactNode }) {
    return (
      <View accessibilityRole="tablist">
        {React.Children.toArray(children).map((child: any) => (
          <Pressable
            key={child.props.name}
            accessibilityLabel={child.props.options.tabBarAccessibilityLabel}
            accessibilityRole="tab"
          />
        ))}
      </View>
    );
  }

  Tabs.Screen = () => null;
  return { Tabs };
});

describe('native foundation', () => {
  it('renders the three native tabs in exact order', async () => {
    const { getAllByRole } = await render(<TabsLayout />);

    expect(getAllByRole('tab').map((tab) => tab.props.accessibilityLabel)).toEqual([
      'Analyze',
      'History',
      'Settings',
    ]);
  });

  it('supplies a 48-point target and semantic text, icon, and status colors', () => {
    expect(tokens.target.minimum).toBeGreaterThanOrEqual(48);
    expect(tokens.color.text).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens.color.icon).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens.color.danger).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens.color.warning).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('pairs development builds with the native dev client and exact React test renderer', () => {
    expect(easConfig.build.development.developmentClient).toBe(true);
    expect(packageManifest.dependencies['expo-dev-client']).toBeDefined();
    expect(packageManifest.devDependencies['react-test-renderer']).toBe(
      packageManifest.dependencies.react,
    );
  });
});
