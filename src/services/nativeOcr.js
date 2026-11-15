import { Capacitor, registerPlugin } from "@capacitor/core";
const Native = registerPlugin("BusVisionNative");
export const canUseNativeOcr = () =>
  Capacitor.isNativePlatform() &&
  Capacitor.isPluginAvailable("BusVisionNative");
export const recognizeNativeText = (image) => Native.recognizeText({ image });
