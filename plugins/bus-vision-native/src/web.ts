import { WebPlugin } from '@capacitor/core';
import type { BusVisionNativePlugin } from './definitions';

export class BusVisionNativeWeb extends WebPlugin implements BusVisionNativePlugin {
  async recognizeText(_options: { image: string }): Promise<never> { throw this.unavailable('Native text recognition is only available on Android and iOS.'); }
  async ensurePermissions(): Promise<{ camera: string; microphone: string }> { return { camera: 'granted', microphone: 'granted' }; }
  async startCamera(): Promise<{ ok: boolean }> { return { ok: false }; }
  async stopCamera(): Promise<{ ok: boolean }> { return { ok: true }; }
  async startRecording(): Promise<{ ok: boolean }> { return { ok: false }; }
  async stopRecording(): Promise<{ path: string; filename: string; mimeType: string }> { return { path: '', filename: '', mimeType: '' }; }
  async takePhoto(): Promise<{ ok: boolean; path: string; filename: string; mimeType: string }> { return { ok: false, path: '', filename: '', mimeType: '' }; }
}
