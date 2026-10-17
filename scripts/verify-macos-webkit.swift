// CI-only: use the system WebKit decoder, without launching a browser or audio playback.
// Usage: swift scripts/verify-macos-webkit.swift <music.ogg> <voice.ogg>
import Cocoa
import Darwin
import Foundation
import WebKit

private func emitJSON(_ value: [String: Any]) {
    do {
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
    } catch {
        FileHandle.standardError.write(Data("Could not encode verification result: \(error)\n".utf8))
    }
}

@MainActor
private final class WebKitVerifier: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private var webView: WKWebView!
    private var window: NSWindow!
    private var timer: Timer?
    private var finished = false

    func start(payload: String) {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "verification")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
        webView.navigationDelegate = self
        // Keep the view in a native hierarchy without showing a window or taking focus.
        window = NSWindow(contentRect: webView.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = webView
        timer = Timer.scheduledTimer(timeInterval: 28, target: self, selector: #selector(timedOut), userInfo: nil, repeats: false)

        let html = """
        <!doctype html><meta charset="utf-8"><title>DBX audio verification</title>
        <script>
        (() => {
          let reported = false;
          const report = result => {
            if (reported) return;
            reported = true;
            window.webkit.messageHandlers.verification.postMessage(result);
          };
          const describe = error => error && (error.stack || error.message) || String(error);
          window.addEventListener('error', event => report({ok:false, error:describe(event.error || event.message)}));
          window.addEventListener('unhandledrejection', event => report({ok:false, error:describe(event.reason)}));
          const inputs = \(payload);
          (async () => {
            let context;
            try {
              const AudioContextClass = window.AudioContext || window.webkitAudioContext;
              if (!AudioContextClass) throw new Error('Web Audio is unavailable in system WebKit');
              context = new AudioContextClass();
              const results = [];
              for (const input of inputs) {
                const binary = atob(input.base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                let decoded;
                try { decoded = await context.decodeAudioData(bytes.buffer); }
                catch (error) { throw new Error(input.kind + ' OGG decode failed: ' + describe(error)); }
                if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.length <= 0)
                  throw new Error(input.kind + ' decoded to an empty or invalid audio buffer');
                results.push({kind:input.kind, duration:decoded.duration, frames:decoded.length,
                  sampleRate:decoded.sampleRate, channels:decoded.numberOfChannels});
              }
              await context.close();
              context = null;
              report({ok:true, userAgent:navigator.userAgent, results});
            } catch (error) {
              report({ok:false, error:describe(error)});
            } finally {
              if (context) void context.close().catch(() => {});
            }
          })().catch(error => report({ok:false, error:describe(error)}));
        })();
        </script>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "verification", message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any], let ok = body["ok"] as? Bool else {
            finish(ok: false, details: ["error": "Invalid WebKit verification message"])
            return
        }
        if ok {
            guard let results = body["results"] as? [[String: Any]], results.count == 2,
                  Set(results.compactMap { $0["kind"] as? String }) == Set(["music", "voice"]),
                  results.allSatisfy({ result in
                      guard let duration = result["duration"] as? NSNumber,
                            let frames = result["frames"] as? NSNumber else { return false }
                      return duration.doubleValue.isFinite && duration.doubleValue > 0 && frames.intValue > 0
                  }) else {
                finish(ok: false, details: ["error": "WebKit returned incomplete audio decode results"])
                return
            }
        }
        finish(ok: ok, details: body)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(ok: false, details: ["error": "WebKit navigation failed: \(error.localizedDescription)"])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(ok: false, details: ["error": "WebKit provisional navigation failed: \(error.localizedDescription)"])
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(ok: false, details: ["error": "WebKit content process terminated"])
    }

    @objc private func timedOut() {
        finish(ok: false, details: ["error": "System WebKit audio decoding timed out after 28 seconds"])
    }

    private func finish(ok: Bool, details: [String: Any]) {
        guard !finished else { return }
        finished = true
        timer?.invalidate()
        var report = details
        report["ok"] = ok
        report["status"] = ok ? "passed" : "failed"
        report["engine"] = "system WKWebView"
        report["macOS"] = ProcessInfo.processInfo.operatingSystemVersionString
        #if arch(arm64)
        report["architecture"] = "arm64"
        #elseif arch(x86_64)
        report["architecture"] = "x64"
        #else
        report["architecture"] = "unknown"
        #endif
        emitJSON(report)
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "verification")
        Darwin.exit(ok ? EXIT_SUCCESS : EXIT_FAILURE)
    }
}

guard CommandLine.arguments.count == 3 else {
    emitJSON(["ok": false, "error": "Usage: swift verify-macos-webkit.swift <music.ogg> <voice.ogg>"])
    Darwin.exit(EXIT_FAILURE)
}

do {
    let inputs: [[String: String]] = try zip(["music", "voice"], CommandLine.arguments.dropFirst()).map { kind, path in
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard !data.isEmpty, data.count <= 32 * 1024 * 1024, data.starts(with: Data("OggS".utf8)) else {
            throw NSError(domain: "DBXWebKitVerification", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "\(kind) must be a nonempty OGG file no larger than 32 MiB"])
        }
        return ["kind": kind, "base64": data.base64EncodedString()]
    }
    let payloadData = try JSONSerialization.data(withJSONObject: inputs, options: [.sortedKeys])
    let payload = String(decoding: payloadData, as: UTF8.self).replacingOccurrences(of: "</", with: "<\\/")
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let verifier = WebKitVerifier()
    verifier.start(payload: payload)
    withExtendedLifetime(verifier) { application.run() }
    emitJSON(["ok": false, "error": "Application loop exited before verification completed"])
    Darwin.exit(EXIT_FAILURE)
} catch {
    emitJSON(["ok": false, "error": "Could not prepare audio verification: \(error.localizedDescription)"])
    Darwin.exit(EXIT_FAILURE)
}
