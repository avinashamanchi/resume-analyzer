import { render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { TabsLayout } from '../app/(tabs)/_layout';
import appConfig from '../app.config';
import { tokens } from '../src/theme/tokens';

const easConfig = require('../eas.json');
const appManifest = require('../app.json').expo;
const packageManifest = require('../package.json');
const { stripDevelopmentNetworkKeys } = require('../plugins/withReleaseNetworkPolicy.cjs') as {
  stripDevelopmentNetworkKeys: (value: Record<string, unknown>) => Record<string, unknown>;
};

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

  Tabs.Screen = function TabScreen() { return null; };
  return { Tabs };
});

describe('native foundation', () => {
  it('renders the four native tabs in exact order', async () => {
    const { getAllByRole } = await render(<TabsLayout />);

    expect(getAllByRole('tab').map((tab) => tab.props.accessibilityLabel)).toEqual([
      'Analyze',
      'History',
      'Workspace',
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

  it('ships an HTTPS-only transport policy without development discovery declarations', () => {
    expect(appManifest.plugins).toContain('./plugins/withReleaseNetworkPolicy.cjs');
    expect(stripDevelopmentNetworkKeys({
      NSBonjourServices: ['_expo._tcp'],
      NSLocalNetworkUsageDescription: 'Development server discovery',
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
        NSAllowsArbitraryLoadsForMedia: true,
        NSAllowsArbitraryLoadsInWebContent: true,
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } },
      },
    })).toEqual({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } });
  });

  it('declares app-collected data without tracking or tracking domains', () => {
    const privacy = appManifest.ios.privacyManifests;
    expect(privacy.NSPrivacyTracking).toBe(false);
    expect(privacy.NSPrivacyTrackingDomains).toEqual([]);
    expect(privacy.NSPrivacyCollectedDataTypes.map(
      (entry: { NSPrivacyCollectedDataType: string }) => entry.NSPrivacyCollectedDataType,
    )).toEqual([
      'NSPrivacyCollectedDataTypeOtherUserContent',
      'NSPrivacyCollectedDataTypeDeviceID',
      'NSPrivacyCollectedDataTypePurchaseHistory',
      'NSPrivacyCollectedDataTypeProductInteraction',
      'NSPrivacyCollectedDataTypePerformanceData',
      'NSPrivacyCollectedDataTypeOtherDiagnosticData',
    ]);
    expect(privacy.NSPrivacyCollectedDataTypes.every(
      (entry: { NSPrivacyCollectedDataTypeTracking: boolean }) => (
        entry.NSPrivacyCollectedDataTypeTracking === false
      ),
    )).toBe(true);
  });

  it('uses remote App Store build-number auto-increment without submission credentials', () => {
    expect(easConfig.cli).toMatchObject({ appVersionSource: 'remote', requireCommit: true });
    expect(easConfig.build.production).toEqual({
      distribution: 'store',
      autoIncrement: true,
      env: {
        EXPO_PUBLIC_RESUME_API_URL: 'https://resume-analyzer-al3g.onrender.com',
      },
      ios: { image: 'auto' },
    });
    expect(easConfig).not.toHaveProperty('submit');
    expect(JSON.stringify(easConfig)).not.toMatch(/appleId|ascApiKey|password/i);
  });

  it('fails a production build without the exact API origin and a public RevenueCat Apple key', () => {
    const originalProfile = process.env.EAS_BUILD_PROFILE;
    const originalApiUrl = process.env.EXPO_PUBLIC_RESUME_API_URL;
    const originalRevenueCatKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
    try {
      process.env.EAS_BUILD_PROFILE = 'production';
      process.env.EXPO_PUBLIC_RESUME_API_URL = 'https://resume-analyzer-al3g.onrender.com';
      delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
      expect(() => appConfig({ config: appManifest } as never)).toThrow('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY');
      process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_replace_with_revenuecat_public_sdk_key';
      expect(() => appConfig({ config: appManifest } as never)).toThrow('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY');
      process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_placeholder_public_sdk_key';
      expect(() => appConfig({ config: appManifest } as never)).toThrow('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY');
      process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'appl_AbCdEfGhIjKlMnOp';
      process.env.EXPO_PUBLIC_RESUME_API_URL = 'http://localhost:5000';
      expect(() => appConfig({ config: appManifest } as never)).toThrow('EXPO_PUBLIC_RESUME_API_URL');
      process.env.EXPO_PUBLIC_RESUME_API_URL = 'https://resume-analyzer-al3g.onrender.com';
      const releaseConfig = appConfig({ config: appManifest } as never);
      expect(releaseConfig.ios?.usesAppleSignIn).toBeUndefined();
      expect(releaseConfig.plugins).not.toContain('expo-apple-authentication');
      expect(packageManifest.dependencies['expo-apple-authentication']).toBeUndefined();
    } finally {
      if (originalProfile === undefined) delete process.env.EAS_BUILD_PROFILE;
      else process.env.EAS_BUILD_PROFILE = originalProfile;
      if (originalApiUrl === undefined) delete process.env.EXPO_PUBLIC_RESUME_API_URL;
      else process.env.EXPO_PUBLIC_RESUME_API_URL = originalApiUrl;
      if (originalRevenueCatKey === undefined) delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
      else process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = originalRevenueCatKey;
    }
  });
});
