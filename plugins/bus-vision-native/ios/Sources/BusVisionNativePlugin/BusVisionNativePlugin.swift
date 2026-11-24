import Foundation
import Capacitor
import Vision
import ImageIO

/**
 * Please read the Capacitor iOS Plugin Development Guide
 * here: https://capacitorjs.com/docs/plugins/ios
 */
@objc(BusVisionNativePlugin)
public class BusVisionNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BusVisionNativePlugin"
    public let jsName = "BusVisionNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startZoomCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCameraRatio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "layoutZoomPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "zoomFrame", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopZoomCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "echo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise)
    ]
    private let camera = BusCamera()
    @objc func startZoomCamera(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.camera.start(call, webView: self.webView) }
    }
    @objc func layoutZoomPreview(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.camera.layout(call, webView: self.webView) }
    }
    @objc func setCameraRatio(_ call: CAPPluginCall) { camera.zoom(call) }
    @objc func zoomFrame(_ call: CAPPluginCall) { camera.frame(call) }
    @objc func stopZoomCamera(_ call: CAPPluginCall) { camera.stop(call) }

    private let implementation = BusVisionNative()

    private let ocrQueue = DispatchQueue(label: "busvision.ocr", qos: .userInitiated)
    private let ocrLock = NSLock()
    private var ocrBusy = false

    @objc func recognizeText(_ call: CAPPluginCall) {
        guard let encoded = call.getString("image"), encoded.count <= 16_000_000 else { call.reject("Invalid OCR image"); return }
        ocrLock.lock()
        if ocrBusy { ocrLock.unlock(); call.reject("OCR_BUSY"); return }
        ocrBusy = true
        ocrLock.unlock()
        ocrQueue.async {
            defer { self.ocrLock.lock(); self.ocrBusy = false; self.ocrLock.unlock() }
            let started = CFAbsoluteTimeGetCurrent()
            let base64 = encoded.components(separatedBy: ",").last ?? encoded
            guard let data = Data(base64Encoded: base64), let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 2200, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { call.reject("Cannot decode OCR image"); return }
            do {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = false
                let supported = try request.supportedRecognitionLanguages()
                request.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US"].filter { supported.contains($0) }
                try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
                let lines: [[String: Any]] = (request.results ?? []).compactMap { observation in
                    guard let text = observation.topCandidates(1).first else { return nil }
                    let box = observation.boundingBox
                    return ["text": text.string, "confidence": text.confidence, "x": box.minX * Double(image.width), "y": (1 - box.maxY) * Double(image.height), "w": box.width * Double(image.width), "h": box.height * Double(image.height)]
                }
                call.resolve(["lines": lines, "width": image.width, "height": image.height, "engine": "apple-vision", "elapsedMs": (CFAbsoluteTimeGetCurrent() - started) * 1000])
            } catch { call.reject("Native OCR failed", nil, error) }
        }
    }

    @objc func echo(_ call: CAPPluginCall) {
        let value = call.getString("value") ?? ""
        call.resolve([
            "value": implementation.echo(value)
        ])
    }
}
