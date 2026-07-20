import Capacitor
import AVFoundation
import UIKit

@objc(AppSettingsPlugin)
class AppSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "AppSettingsPlugin"
    let jsName = "AppSettings"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cameraStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestCamera", returnType: CAPPluginReturnPromise),
    ]

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("App Settings URL is unavailable.")
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                opened ? call.resolve() : call.reject("Could not open App Settings.")
            }
        }
    }

    @objc func cameraStatus(_ call: CAPPluginCall) {
        call.resolve(["status": cameraPermissionName(AVCaptureDevice.authorizationStatus(for: .video))])
    }

    @objc func requestCamera(_ call: CAPPluginCall) {
        AVCaptureDevice.requestAccess(for: .video) { _ in
            call.resolve(["status": cameraPermissionName(AVCaptureDevice.authorizationStatus(for: .video))])
        }
    }
}

private func cameraPermissionName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "prompt"
    @unknown default: return "unavailable"
    }
}

@objc(AppBridgeViewController)
class AppBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(AppSettingsPlugin())
        if #available(iOS 16.2, *) {
            bridge?.registerPluginInstance(AppLiveActivityPlugin())
        }
    }
}
