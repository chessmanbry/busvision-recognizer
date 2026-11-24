import AVFoundation
import CoreImage
import UIKit
import WebKit
import Capacitor

/// Camera configuration and frame reads are serialized. The preview is rendered by AVFoundation.
final class BusCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let queue = DispatchQueue(label: "busvision.camera", qos: .userInitiated)
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private var session: AVCaptureSession?
    private var device: AVCaptureDevice?
    private var token = ""
    private var sequence = 0
    private var latest: CVPixelBuffer?
    // Preview views are accessed only on the main queue.
    private var preview: AVCaptureVideoPreviewLayer?
    private var container: UIView?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(background),
            name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    @objc private func background() {
        queue.async { self.close() }
    }

    private func close() {
        session?.stopRunning()
        session = nil
        device = nil
        latest = nil
        token = ""
        DispatchQueue.main.async {
            self.container?.removeFromSuperview()
            self.container = nil
            self.preview = nil
        }
    }

    func start(_ call: CAPPluginCall, webView: WKWebView?) {
        guard let token = call.getString("session"), let webView, webView.superview != nil else {
            call.reject("Camera view unavailable")
            return
        }
        queue.async {
            self.close()
            self.token = token
            func configure(_ granted: Bool) {
                self.queue.async {
                    guard self.token == token, granted else { call.reject("Camera cancelled or permission denied"); return }
                    let types: [AVCaptureDevice.DeviceType] = [.builtInTripleCamera, .builtInDualCamera, .builtInDualWideCamera, .builtInWideAngleCamera]
                    guard let device = types.lazy.compactMap({ AVCaptureDevice.default($0, for: .video, position: .back) }).first else {
                        call.reject("No rear camera")
                        return
                    }
                    do {
                        let input = try AVCaptureDeviceInput(device: device)
                        let session = AVCaptureSession()
                        let output = AVCaptureVideoDataOutput()
                        output.alwaysDiscardsLateVideoFrames = true
                        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
                        guard session.canAddInput(input) else { call.reject("Camera input unavailable"); return }
                        session.addInput(input)
                        guard session.canAddOutput(output) else { call.reject("Camera output unavailable"); return }
                        session.addOutput(output)
                        if session.canSetSessionPreset(.hd1920x1080) { session.sessionPreset = .hd1920x1080 }
                        let wideIndex = device.constituentDevices.firstIndex { $0.deviceType == .builtInWideAngleCamera } ?? 0
                        let base = wideIndex > 0 ? CGFloat(device.virtualDeviceSwitchOverVideoZoomFactors[wideIndex - 1].doubleValue) : 1
                        self.baseZoom = base
                        try device.lockForConfiguration()
                        device.videoZoomFactor = base
                        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
                        if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
                        device.unlockForConfiguration()
                        output.connection(with: .video)?.videoOrientation = .portrait
                        output.setSampleBufferDelegate(self, queue: self.queue)
                        self.session = session
                        self.device = device
                        DispatchQueue.main.async {
                            let layer = AVCaptureVideoPreviewLayer(session: session)
                            layer.videoGravity = .resizeAspectFill
                            layer.connection?.videoOrientation = .portrait
                            let view = UIView()
                            view.isUserInteractionEnabled = false
                            view.accessibilityElementsHidden = true
                            view.clipsToBounds = true
                            webView.isOpaque = false
                            webView.backgroundColor = .clear
                            webView.scrollView.backgroundColor = .clear
                            webView.superview?.insertSubview(view, belowSubview: webView)
                            view.layer.addSublayer(layer)
                            self.container = view
                            self.preview = layer
                        }
                        session.startRunning()
                        call.resolve(["max": min(15, device.maxAvailableVideoZoomFactor / base)])
                    } catch { self.close(); call.reject("Camera setup failed", nil, error) }
                }
            }
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
                AVCaptureDevice.requestAccess(for: .video, completionHandler: configure)
            } else { configure(AVCaptureDevice.authorizationStatus(for: .video) == .authorized) }
        }
    }

    private var baseZoom: CGFloat = 1

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard output === session?.outputs.first else { return }
        latest = CMSampleBufferGetImageBuffer(sampleBuffer)
        sequence += 1
    }

    func frame(_ call: CAPPluginCall) {
        queue.async {
            guard self.token == call.getString("session"), let buffer = self.latest,
                  self.sequence != call.getInt("after") else { call.resolve(); return }
            guard let jpeg = self.context.jpegRepresentation(of: CIImage(cvPixelBuffer: buffer), colorSpace: self.colorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9]) else {
                call.reject("Camera JPEG unavailable")
                return
            }
            call.resolve(["jpeg": jpeg.base64EncodedString(), "seq": self.sequence, "rotation": 0,
                          "lens": self.device?.localizedName ?? ""])
        }
    }

    func zoom(_ call: CAPPluginCall) {
        queue.async {
            guard self.token == call.getString("session"), let d = self.device else { call.reject("Camera closed"); return }
            do {
                try d.lockForConfiguration()
                defer { d.unlockForConfiguration() }
                d.videoZoomFactor = min(d.maxAvailableVideoZoomFactor, max(d.minAvailableVideoZoomFactor, CGFloat(call.getDouble("ratio") ?? 1) * self.baseZoom))
                call.resolve()
            } catch { call.reject("Zoom unavailable", nil, error) }
        }
    }

    func layout(_ call: CAPPluginCall, webView: WKWebView?) {
        guard let webView, let container, let preview else { call.resolve(); return }
        let scale = webView.bounds.width / CGFloat(max(1, call.getDouble("viewport") ?? 1))
        func points(_ key: String) -> CGFloat { CGFloat(call.getDouble(key) ?? 0) * scale }
        container.frame = webView.convert(CGRect(x: points("x"), y: points("y"), width: points("width"), height: points("height")), to: webView.superview)
        let extra = CGFloat(max(1, call.getDouble("extension") ?? 1))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        preview.bounds = container.bounds
        preview.position = CGPoint(x: container.bounds.midX, y: container.bounds.midY)
        preview.setAffineTransform(CGAffineTransform(scaleX: call.getBool("mirror") == true ? -extra : extra, y: extra))
        CATransaction.commit()
        call.resolve()
    }

    func stop(_ call: CAPPluginCall) {
        queue.async {
            if self.token == call.getString("session") { self.close() }
            call.resolve()
        }
    }
}
