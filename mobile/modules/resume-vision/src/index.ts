import { requireNativeModule } from 'expo-modules-core';

export type ResumeVisionResult = Readonly<{
  text: string;
  pageCount: number;
}>;

export type ResumeVisionNativeModule = Readonly<{
  extractTextFromPdf(uri: string, operationId: string): Promise<ResumeVisionResult>;
  cancelExtraction(operationId: string): Promise<void>;
}>;

export default requireNativeModule<ResumeVisionNativeModule>('ResumeVision');
