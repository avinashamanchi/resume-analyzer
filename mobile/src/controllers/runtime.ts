import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { Share } from 'react-native';

import { AnalysisCoordinator, type AnalysisApiPort } from '../analysis/analysisCoordinator';
import { ResumeApi } from '../api/resumeApi';
import { ResumeApiError } from '../domain/errors';
import { DocumentSourceService } from '../documents/documentSource';
import { TempFileRegistry } from '../documents/tempFileRegistry';
import { VisionAdapter } from '../documents/visionAdapter';
import { ConsentStore } from '../security/consentStore';
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

  if (typeof injectedOrigin === 'string' && injectedOrigin.length > 0) {
    try {
      const installationTokens = new InstallationTokenStore({ apiBaseUrl: injectedOrigin });
      api = new ResumeApi({ apiBaseUrl: injectedOrigin, installationTokens });
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
    createRepository: () => new ReportRepository({ tempFiles: registry }),
  };
}
