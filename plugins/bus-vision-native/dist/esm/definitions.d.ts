export interface BusVisionNativePlugin {
    recognizeText(options: {
        image: string;
    }): Promise<{
        lines: Array<{
            text: string;
            confidence: number;
            x: number;
            y: number;
            w: number;
            h: number;
        }>;
        width: number;
        height: number;
        engine: string;
        elapsedMs: number;
    }>;
    ensurePermissions(): Promise<{
        ok?: boolean;
        camera: string;
        mic?: string;
        microphone?: string;
    }>;
    startCamera(): Promise<{
        ok?: boolean;
    }>;
    stopCamera(): Promise<{
        ok?: boolean;
    }>;
    startRecording(options?: {
        sessionId?: string;
        sampleRate?: number;
        channels?: number;
    }): Promise<{
        ok: boolean;
    }>;
    stopRecording(options?: {
        sessionId?: string;
    }): Promise<{
        path: string;
        audioPath?: string;
        filename?: string;
        mimeType?: string;
        durationMs?: number;
        sizeBytes?: number;
        cameraMeta?: {
            iso?: number;
            exposureTimeNs?: number;
            device?: string;
        };
    }>;
    takePhoto(options?: {
        filename?: string;
    }): Promise<{
        ok: boolean;
        path: string;
        filename: string;
        mimeType: string;
        width?: number;
        height?: number;
    }>;
}
