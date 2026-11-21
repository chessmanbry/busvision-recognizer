import { Capacitor, registerPlugin } from "@capacitor/core";
const Native = registerPlugin("BusVisionNative");
export const canUseNativeOcr = () =>
  Capacitor.isNativePlatform() &&
  Capacitor.isPluginAvailable("BusVisionNative");
// The native recognizer accepts one request at a time. Serialize the two live
// producers (whole frame and tracked vehicle) instead of losing one to OCR_BUSY.
let previous = Promise.resolve();
export function recognizeNativeText(image) {
  const run = () => Native.recognizeText({image});
  const result = previous.then(run);
  previous = result.catch(() => {});
  return result;
}
