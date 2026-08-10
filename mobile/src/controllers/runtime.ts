import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { Share } from 'react-native';

import { AnalysisCoordinator, type AnalysisApiPort } from '../analysis/analysisCoordinator';
import { PlanApi } from '../api/planApi';
import { ResumeApi } from '../api/resumeApi';
import {
  RevenueCatBillingService,
} from '../billing/revenueCatService';
import { AppleAccountLinker } from '../billing/appleAccountLinker';
import {
  RESUME_PRO_ENTITLEMENT,
  RESUME_PRO_PRODUCT_IDS,
  type BillingService,
} from '../billing/BillingProvider';
import { ResumeApiError } from '../domain/errors';
import { DocumentSourceService } from '../documents/documentSource';
import { TempFileRegistry } from '../documents/tempFileRegistry';
import { VisionAdapter } from '../documents/visionAdapter';
import { ConsentStore } from '../security/consentStore';
import { AccountIdentityStore } from '../security/accountIdentity';
import { InstallationTokenStore } from '../security/installationToken';
import { ReportRepository } from '../storage/reportRepository';
import type { AppServices } from './AppController';

export const SUPPORT_URL = 'https://resume-analyzer-al3g.onrender.com/static/support.html';

class UnavailableApi implements AnalysisApiPort {
  async analyze(): Promise<never> {
    throw new ResumeApiError('service', {
      code: 'service_unavailable',
      retryable: false,
    });
  }
}

export type RuntimeComposition = Readonly<{
  services: AppServices;
  coordinator: AnalysisCoordinator;
  billingService?: BillingService;
  createRepository(): ReportRepository;
}>;

export function createRuntimeComposition(
  injectedOrigin: string | undefined = process.env.EXPO_PUBLIC_RESUME_API_URL,
): RuntimeComposition {
  const registry = new TempFileRegistry();
  const documents = new DocumentSourceService({ registry });
  const vision = new VisionAdapter();
  const consent = new ConsentStore();
  let serviceAvailable = false;
  let api: AnalysisApiPort = new UnavailableApi();
  let billingService: BillingService | undefined;

  if (typeof injectedOrigin === 'string' && injectedOrigin.length > 0) {
    try {
      const installationTokens = new InstallationTokenStore({ apiBaseUrl: injectedOrigin });
      const accountIdentity = new AccountIdentityStore();
      api = new ResumeApi({
        apiBaseUrl: injectedOrigin,
        installationTokens,
        accountIdentity,
      });
      const planApi = new PlanApi({
        apiBaseUrl: injectedOrigin,
        installationTokens,
        accountIdentity,
      });
      const revenueCatBilling = new RevenueCatBillingService({
        apiKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
        entitlementId: RESUME_PRO_ENTITLEMENT,
        executionEnvironment: Constants.executionEnvironment,
        installationTokens,
        planApi,
        productIds: RESUME_PRO_PRODUCT_IDS,
      });
      const appleAccountLinker = new AppleAccountLinker({
        planApi,
        accountStore: accountIdentity,
        billing: revenueCatBilling,
      });
      billingService = {
        load: () => revenueCatBilling.load(),
        purchase: productId => revenueCatBilling.purchase(productId),
        restore: () => revenueCatBilling.restore(),
        linkApple: () => appleAccountLinker.link(new AbortController().signal),
      };
      serviceAvailable = true;
    } catch {
      api = new UnavailableApi();
    }
  }

  const coordinator = new AnalysisCoordinator({
    api,
    consentStore: consent,
    tempFiles: registry,
    pdfOwnership: registry,
    vision,
  });
  const services: AppServices = {
    documents,
    consent,
    cache: registry,
    serviceAvailable,
    appVersion: Constants.expoConfig?.version ?? '1.0.0',
    async shareText(text: string) {
      await Share.share({ message: text });
    },
    async openSupport() {
      await Linking.openURL(SUPPORT_URL);
    },
  };

  return {
    services,
    coordinator,
    billingService,
    createRepository: () => new ReportRepository({ tempFiles: registry }),
  };
}
