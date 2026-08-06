import { requireNativeModule } from 'expo-modules-core';

export type ResumeVisionResult = Readonly<{
  text: string;
  pageCount: number;
}>;

export type ResumeVisionNativeModule = Readonly<{
  extractTextFromPdf(uri: string): Promise<ResumeVisionResult>;
}>;

export default requireNativeModule<ResumeVisionNativeModule>('ResumeVision');
