import AppKit
import WebKit

struct LauncherConfig: Decodable {
    let projectPath: String
    let nodePath: String
}

final class TrieresApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let checking = CommandLine.arguments.contains("--check")
    private var window: NSWindow!
    private var webView: WKWebView?
    private var loadingView: NSView?
    private var server: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var log: FileHandle?
    private var pendingOutput = Data()
    private var gameURL: URL?
    private var ready = false
    private var stopping = false
    private var failed = false
    private var logURL: URL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !checking { makeMenus(); makeWindow() }
        do { try startServer() } catch { fail(error.localizedDescription) }
    }

    private func makeMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Trieres", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Trieres", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Trieres", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let gameItem = NSMenuItem()
        menu.addItem(gameItem)
        let gameMenu = NSMenu(title: "Game")
        gameItem.submenu = gameMenu
        gameMenu.addItem(withTitle: "Reload Game", action: #selector(reloadGame), keyEquivalent: "r").target = self
        let fullscreen = gameMenu.addItem(withTitle: "Enter Full Screen", action: #selector(toggleFullscreen), keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.command, .control]
        fullscreen.target = self
        gameMenu.addItem(.separator())
        gameMenu.addItem(withTitle: "Show Server Log", action: #selector(showLog), keyEquivalent: "").target = self
        NSApp.mainMenu = menu
    }

    private func makeWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Trieres"
        window.minSize = NSSize(width: 800, height: 560)
        window.collectionBehavior = [.fullScreenPrimary]
        window.backgroundColor = NSColor(calibratedRed: 0.025, green: 0.055, blue: 0.09, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("TrieresGameWindow")
        window.center()
        let container = NSView()
        let icon = NSImageView()
        icon.image = NSApp.applicationIconImage
        icon.imageScaling = .scaleProportionallyUpOrDown
        let title = NSTextField(labelWithString: "Trieres")
        title.font = .systemFont(ofSize: 32, weight: .light)
        title.textColor = NSColor(calibratedRed: 0.94, green: 0.88, blue: 0.72, alpha: 1)
        let subtitle = NSTextField(labelWithString: "Preparing the Aegean…")
        subtitle.textColor = .secondaryLabelColor
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.startAnimation(nil)
        let stack = NSStackView(views: [icon, title, subtitle, spinner])
        stack.orientation = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 128), icon.heightAnchor.constraint(equalToConstant: 128),
        ])
        window.contentView = container
        loadingView = container
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func startServer() throws {
        guard let resources = Bundle.main.resourceURL else { throw problem("The launcher is missing its resources.") }
        let config = try JSONDecoder().decode(LauncherConfig.self, from: Data(contentsOf: resources.appendingPathComponent("launcher.json")))
        let nextToApp = Bundle.main.bundleURL.deletingLastPathComponent()
        let project = FileManager.default.fileExists(atPath: nextToApp.appendingPathComponent("scripts/macos/Trieres.swift").path)
            ? nextToApp : URL(fileURLWithPath: config.projectPath)
        guard FileManager.default.fileExists(atPath: project.appendingPathComponent("package.json").path) else {
            throw problem("The game folder could not be found at \(project.path). Move Trieres.app back beside the game's package.json or rebuild the launcher from the project.")
        }
        let nodePath = [config.nodePath, "/opt/homebrew/bin/node", "/usr/local/bin/node"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let nodePath else { throw problem("Node.js could not be found. Install Node.js and rebuild the launcher from the game project.") }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Trieres", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        logURL = support.appendingPathComponent(checking ? "launcher-check.log" : "launcher.log")
        FileManager.default.createFile(atPath: logURL.path, contents: Data())
        log = try FileHandle(forWritingTo: logURL)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [resources.appendingPathComponent("server.mjs").path, "--project", project.path]
        if checking {
            process.arguments! += ["--port", "0"]
        } else {
            process.arguments! += ["--state", support.appendingPathComponent("server.json").path]
        }
        process.currentDirectoryURL = project
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        input = Pipe()
        output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = output
        output!.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.receive(data) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.stopping else { return }
                self.fail("The game server stopped (exit \(process.terminationStatus)). The server log contains the details.")
            }
        }
        server = process
        try process.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            guard let self, !self.ready, !self.stopping else { return }
            self.fail("The server took too long to start. Check the server log, then reopen Trieres.")
        }
    }

    private func receive(_ data: Data) {
        try? log?.write(contentsOf: data)
        pendingOutput.append(data)
        while let newline = pendingOutput.firstIndex(of: 10) {
            let line = String(decoding: pendingOutput[..<newline], as: UTF8.self)
            pendingOutput.removeSubrange(...newline)
            guard !ready, line.hasPrefix("TRIERES_READY "),
                  let json = line.dropFirst("TRIERES_READY ".count).data(using: .utf8),
                  let result = try? JSONDecoder().decode([String: String].self, from: json),
                  let address = result["url"], let url = URL(string: address), url.host == "127.0.0.1" else { continue }
            ready = true
            gameURL = url
            if checking { checkServer(url) } else { openGame(url) }
        }
    }

    // This deliberately checks HTTP and process startup without loading or testing a browser.
    private func checkServer(_ url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                      let data, String(decoding: data, as: UTF8.self).contains("/src/main.ts") else {
                    self.fail("Server startup check failed: \(error?.localizedDescription ?? "unexpected game response").")
                    return
                }
                print("Trieres launcher check passed: \(url.absoluteString)")
                NSApp.terminate(nil)
            }
        }.resume()
    }

    private func openGame(_ url: URL) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        view.underPageBackgroundColor = window.backgroundColor
        webView = view
        // Keep the launch screen visible until the page has committed.
        window.contentView!.addSubview(view, positioned: .below, relativeTo: nil)
        view.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        window.contentView = webView
        loadingView = nil
        window.makeFirstResponder(webView)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.scheme == "http" && url.host == gameURL?.host && url.port == gameURL?.port) {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("The game window could not load: \(error.localizedDescription)") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let alert = NSAlert()
        alert.messageText = "The game window stopped responding"
        alert.informativeText = "Reload to return to Trieres. Your last saved game is stored on this Mac."
        alert.addButton(withTitle: "Reload Game")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn { webView.reload() } else { NSApp.terminate(nil) }
    }

    private func problem(_ message: String) -> NSError {
        NSError(domain: "TrieresLauncher", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func fail(_ message: String) {
        guard !failed, !stopping else { return }
        failed = true
        if checking { fputs("Trieres launcher check failed: \(message)\n", stderr); NSApp.terminate(nil); return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Trieres couldn’t start"
        alert.informativeText = message
        alert.addButton(withTitle: "Quit")
        if logURL != nil { alert.addButton(withTitle: "Show Server Log") }
        if alert.runModal() == .alertSecondButtonReturn { showLog() }
        NSApp.terminate(nil)
    }

    @objc private func reloadGame() { webView?.reload() }
    @objc private func toggleFullscreen() { window.toggleFullScreen(nil) }
    @objc private func showLog() { if let logURL { NSWorkspace.shared.open(logURL) } }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        stopping = true
        output?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        if let server, server.isRunning {
            server.terminate()
            let limit = Date().addingTimeInterval(4)
            while server.isRunning && Date() < limit { Thread.sleep(forTimeInterval: 0.05) }
            if server.isRunning { kill(server.processIdentifier, SIGKILL) }
        }
        try? log?.close()
        if checking && failed { exit(1) }
    }
}

let app = NSApplication.shared
let delegate = TrieresApp()
app.delegate = delegate
app.setActivationPolicy(CommandLine.arguments.contains("--check") ? .prohibited : .regular)
app.run()
