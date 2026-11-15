import { WebPlugin } from '@capacitor/core';
export class BusVisionNativeWeb extends WebPlugin {
    async recognizeText(_options) { throw this.unavailable('Native text recognition is only available on Android and iOS.'); }
    async ensurePermissions() { return { camera: 'granted', microphone: 'granted' }; }
    async startCamera() { return { ok: false }; }
    async stopCamera() { return { ok: true }; }
    async startRecording() { return { ok: false }; }
    async stopRecording() { return { path: '', filename: '', mimeType: '' }; }
    async takePhoto() { return { ok: false, path: '', filename: '', mimeType: '' }; }
}
//# sourceMappingURL=web.js.map