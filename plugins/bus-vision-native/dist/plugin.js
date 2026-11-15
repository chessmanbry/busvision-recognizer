var capacitorBusVisionNative = (function (exports, core) {
    'use strict';

    const BusVisionNative = core.registerPlugin('BusVisionNative', {
        web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.BusVisionNativeWeb()),
    });

    class BusVisionNativeWeb extends core.WebPlugin {
        async recognizeText(_options) { throw this.unavailable('Native text recognition is only available on Android and iOS.'); }
        async ensurePermissions() { return { camera: 'granted', microphone: 'granted' }; }
        async startCamera() { return { ok: false }; }
        async stopCamera() { return { ok: true }; }
        async startRecording() { return { ok: false }; }
        async stopRecording() { return { path: '', filename: '', mimeType: '' }; }
        async takePhoto() { return { ok: false, path: '', filename: '', mimeType: '' }; }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        BusVisionNativeWeb: BusVisionNativeWeb
    });

    exports.BusVisionNative = BusVisionNative;

    return exports;

})({}, capacitorExports);
//# sourceMappingURL=plugin.js.map
