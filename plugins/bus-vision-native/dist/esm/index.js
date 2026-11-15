import { registerPlugin } from '@capacitor/core';
const BusVisionNative = registerPlugin('BusVisionNative', {
    web: () => import('./web').then((m) => new m.BusVisionNativeWeb()),
});
export * from './definitions';
export { BusVisionNative };
//# sourceMappingURL=index.js.map