import { WebPlugin } from '@capacitor/core';
import type { BusVisionNativePlugin } from './definitions';
export declare class BusVisionNativeWeb extends WebPlugin implements BusVisionNativePlugin {
    recognizeText(_options: {
        image: string;
    }): Promise<never>;
    ensurePermissions(): Promise<{
        camera: string;
        microphone: string;
    }>;
    startCamera(): Promise<{
        ok: boolean;
    }>;
    stopCamera(): Promise<{
        ok: boolean;
    }>;
    startRecording(): Promise<{
        ok: boolean;
    }>;
    stopRecording(): Promise<{
        path: string;
        filename: string;
        mimeType: string;
    }>;
    takePhoto(): Promise<{
        ok: boolean;
        path: string;
        filename: string;
        mimeType: string;
    }>;
}
