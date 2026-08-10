import type { ConfigContext, ExpoConfig } from 'expo/config';

const PRODUCTION_API_ORIGIN = 'https://resume-analyzer-al3g.onrender.com';
const PUBLIC_REVENUECAT_KEY = /^appl_[A-Za-z0-9_-]{8,}$/;

export default function appConfig({ config }: ConfigContext): ExpoConfig {
  if (process.env.EAS_BUILD_PROFILE === 'production') {
    const apiOrigin = process.env.EXPO_PUBLIC_RESUME_API_URL?.trim() ?? '';
    const revenueCatKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.trim() ?? '';
    if (apiOrigin !== PRODUCTION_API_ORIGIN) {
      throw new Error('EXPO_PUBLIC_RESUME_API_URL is invalid for the production build');
    }
    if (
      !PUBLIC_REVENUECAT_KEY.test(revenueCatKey) ||
      revenueCatKey.includes('replace_with')
    ) {
      throw new Error('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY is required for the production build');
    }
  }
  return config as ExpoConfig;
}
