// RemoteTerm — menu bar shell for the remote-term agent.
//
// The agent runs as this app's child, so every shell a phone opens runs under one stable identity:
// this signed bundle. Grant it Full Disk Access once and remote shells can read Desktop, Documents
// and the rest without a permission prompt appearing on a screen nobody is looking at.
// The menu shows the relay link and live sessions, opens a pairing QR code, and stops the agent.
//
// Build + install: bash launcher/build.sh
import AppKit
import CoreImage
import ServiceManagement
import SwiftUI

let home = FileManager.default.homeDirectoryForCurrentUser
let supportDir = home.appendingPathComponent("Library/Application Support/RemoteTerm")
let logDir = home.appendingPathComponent("Library/Logs/RemoteTerm")
let showWindowNotification = Notification.Name("dev.remote-term.launcher.show-window")

func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func qrImage(_ text: String, points: CGFloat) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    let scale = (points * 2) / output.extent.width // drawn at 2x, shown at `points`
    let representation = NSCIImageRep(ciImage: output.transformed(by: CGAffineTransform(scaleX: scale, y: scale)))
    let image = NSImage(size: NSSize(width: points, height: points))
    image.addRepresentation(representation)
    return image
}

// MARK: - Agent child process

final class Agent {
    var onEvent: ([String: Any]) -> Void = { _ in }
    var onExit: (Int32) -> Void = { _ in }
    private var process: Process?
    private var lifeline: Pipe?
    private var pending = Data()
    private var log: FileHandle?

    var isRunning: Bool { process?.isRunning ?? false }

    func start(node: String, script: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script]
        var environment = ProcessInfo.processInfo.environment
        // Login shells rebuild PATH from /etc/zprofile and the owner's own files; this only has to
        // be enough for the agent itself.
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["REMOTE_TERM_PARENT_PIPE"] = "1"
        process.environment = environment
        process.currentDirectoryURL = home

        // We hold the write end of the child's stdin for as long as we live. When this app exits,
        // even by SIGKILL, the agent reads EOF and stops instead of lingering as an orphan.
        let lifeline = Pipe()
        process.standardInput = lifeline
        self.lifeline = lifeline

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        log = openLog()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        process.terminationHandler = { [weak self] finished in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async { self?.onExit(finished.terminationStatus) }
        }
        try process.run()
        self.process = process
    }

    // SIGTERM: the agent hangs up its sessions, closes the relay socket and exits.
    func stop() {
        guard let process, process.isRunning else { return }
        process.terminate()
    }

    func send(_ request: [String: Any]) {
        guard isRunning, let lifeline, let data = try? JSONSerialization.data(withJSONObject: request) else { return }
        try? lifeline.fileHandleForWriting.write(contentsOf: data + Data("\n".utf8))
    }

    private func openLog() -> FileHandle? {
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let url = logDir.appendingPathComponent("agent.log")
        if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 5_000_000 {
            try? FileManager.default.removeItem(at: url)
        }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
        return handle
    }

    // The agent writes one JSON object per line on stdout. Two kinds stay out of the log file:
    // replies to the status window's polling (every 3 s while it is open) and pairing events,
    // whose link carries the one-time secret. Everything else is logged, stray stderr included.
    private static let unlogged: Set<String> = ["reply", "pairing"]

    private func consume(_ data: Data) {
        pending.append(data)
        while let newline = pending.firstIndex(of: 0x0A) {
            let line: Data = pending.subdata(in: pending.startIndex..<(newline + 1))
            let body: Data = pending.subdata(in: pending.startIndex..<newline)
            pending.removeSubrange(pending.startIndex...newline)
            let event = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            let kind: String = (event?["event"] as? String) ?? ""
            if !Agent.unlogged.contains(kind) { log?.write(line) }
            if let event { onEvent(event) }
        }
    }
}

// MARK: - Status window

final class StatusModel: ObservableObject {
    @Published var symbol = "ellipsis.circle"
    @Published var headline = "正在启动…"
    @Published var detail = ""
    @Published var paused = false
    @Published var connected = false
    @Published var loginItem = false
    @Published var fullDiskAccess = false
    @Published var sessions = 0
    @Published var phones = 0
    @Published var devices = 0
    @Published var pairingURL: String?
    @Published var pairingExpires: Date?

    var pair: () -> Void = {}
    var togglePause: () -> Void = {}
    var setLoginItem: (Bool) -> Void = { _ in }
    var openFullDiskAccess: () -> Void = {}
    var openLogs: () -> Void = {}
}

struct PairingView: View {
    let url: String
    let expires: Date

    var body: some View {
        VStack(spacing: 10) {
            if let image = qrImage(url, points: 220) {
                Image(nsImage: image)
                    .interpolation(.none)
                    .frame(width: 220, height: 220)
                    .padding(10)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            Text("用手机相机扫描，按提示创建通行密钥")
            Text("\(expires.formatted(date: .omitted, time: .shortened)) 前有效，只能用一次")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

struct StatusView: View {
    @ObservedObject var model: StatusModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: model.symbol)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(Color.purple)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("RemoteTerm").font(.headline)
                    Text(model.headline).foregroundStyle(.secondary)
                }
            }
            if !model.detail.isEmpty {
                Text(model.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let url = model.pairingURL, let expires = model.pairingExpires {
                GroupBox("配对新设备") { PairingView(url: url, expires: expires).padding(8) }
            }
            GroupBox("状态") {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("会话", value: "\(model.sessions)")
                    LabeledContent("手机连接", value: "\(model.phones)")
                    LabeledContent("已配对的通行密钥", value: "\(model.devices)")
                    HStack {
                        Image(systemName: model.fullDiskAccess ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(model.fullDiskAccess ? Color.green : Color.secondary)
                        Text("完全磁盘访问")
                        Spacer()
                        if !model.fullDiskAccess {
                            Button("去授权…", action: model.openFullDiskAccess).controlSize(.small)
                        } else {
                            Text("已授权").foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(6)
            }
            Toggle("登录时自动启动", isOn: Binding(get: { model.loginItem }, set: { model.setLoginItem($0) }))
            HStack {
                Button(model.paused ? "恢复" : "暂停", action: model.togglePause)
                Button("查看日志", action: model.openLogs)
                Spacer()
                Button("配对新设备…", action: model.pair)
                    .disabled(!model.connected)
                    .keyboardShortcut(.defaultAction)
            }
            Text("没有完全磁盘访问时，远程 shell 读桌面、文稿、下载等文件夹会被系统拦下。授权后要退出并重新打开 RemoteTerm 才生效。")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 440)
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "正在启动…", action: nil, keyEquivalent: "")
    private let countsLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var pairItem: NSMenuItem!
    private var pauseItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private let agent = Agent()
    private let model = StatusModel()
    private var window: NSWindow?
    private var pollTimer: Timer?
    private var paused = false
    private var link = "starting"
    private var restartDelay: TimeInterval = 1
    private var startedAt = Date()
    private var requestCounter = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One RemoteTerm at a time: a second launch asks the running one to show its window and quits.
        let me = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != me }
        if !others.isEmpty {
            DistributedNotificationCenter.default().postNotificationName(
                showWindowNotification, object: nil, userInfo: nil, deliverImmediately: true)
            NSApp.terminate(nil)
            return
        }
        _ = DistributedNotificationCenter.default().addObserver(
            forName: showWindowNotification, object: nil, queue: .main) { [weak self] _ in self?.showWindow() }

        // Writing to the agent's pipe after it died must not take this app down with it.
        signal(SIGPIPE, SIG_IGN)

        wireModel()
        buildMenu()
        agent.onEvent = { [weak self] event in self?.handle(event) }
        agent.onExit = { [weak self] _ in self?.agentExited() }
        startAgent()
        if !launchedAsLoginItem() { showWindow() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        paused = true
        agent.stop()
    }

    func menuWillOpen(_ menu: NSMenu) {
        askStatus()
        render()
    }

    func windowWillClose(_ notification: Notification) {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: setup

    private func wireModel() {
        model.pair = { [weak self] in self?.pair() }
        model.togglePause = { [weak self] in self?.togglePause() }
        model.setLoginItem = { [weak self] enabled in self?.setLoginItem(enabled) }
        model.openFullDiskAccess = { [weak self] in self?.openFullDiskAccess() }
        model.openLogs = { [weak self] in self?.openLogs() }
    }

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        menu.delegate = self
        statusLine.isEnabled = false
        countsLine.isEnabled = false
        pairItem = item("配对新设备…", #selector(pair))
        pauseItem = item("暂停", #selector(togglePause))
        loginItem = item("登录时自动启动", #selector(toggleLoginItem))
        menu.addItem(statusLine)
        menu.addItem(countsLine)
        menu.addItem(.separator())
        menu.addItem(pairItem)
        menu.addItem(item("打开状态窗口", #selector(showWindow)))
        menu.addItem(.separator())
        menu.addItem(pauseItem)
        menu.addItem(loginItem)
        menu.addItem(item("查看日志", #selector(openLogs)))
        menu.addItem(.separator())
        menu.addItem(item("退出 RemoteTerm", #selector(quit), key: "q"))
        statusItem.menu = menu
        render()
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func launchedAsLoginItem() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        return event.eventID == kAEOpenApplication
            && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    // MARK: agent lifecycle

    private var configured: Bool {
        FileManager.default.fileExists(atPath: supportDir.appendingPathComponent("agent.json").path)
    }

    private func startAgent() {
        defer { render() }
        guard !paused, !agent.isRunning else { return }
        guard configured else {
            link = "unconfigured"
            return
        }
        let node = readJSON(supportDir.appendingPathComponent("launcher.json"))?["node"] as? String ?? "/opt/homebrew/bin/node"
        let script = (Bundle.main.resourcePath ?? "") + "/agent/index.js"
        do {
            startedAt = Date()
            try agent.start(node: node, script: script)
            link = "connecting"
        } catch {
            link = "failed"
            scheduleRestart()
        }
    }

    private func agentExited() {
        model.sessions = 0
        model.phones = 0
        clearPairing()
        guard !paused else {
            link = "paused"
            render()
            return
        }
        if Date().timeIntervalSince(startedAt) > 60 { restartDelay = 1 }
        link = "restarting"
        render()
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.startAgent()
        }
    }

    private func ask(_ command: String) {
        requestCounter += 1
        agent.send(["id": "\(command)-\(requestCounter)", "cmd": command])
    }

    private func askStatus() {
        ask("status")
    }

    private func handle(_ event: [String: Any]) {
        switch event["event"] as? String {
        case "status":
            guard let status = event["status"] as? String else { return }
            link = status
            if status == "connected" {
                restartDelay = 1
                askStatus()
            }
        case "sessions":
            model.sessions = event["count"] as? Int ?? model.sessions
        case "links":
            model.phones = event["count"] as? Int ?? model.phones
        case "pairing":
            showPairing(event)
        case "auth":
            // A finished pairing uses up the QR code.
            if event["method"] as? String == "pair-finish", event["ok"] as? Bool == true {
                clearPairing()
                askStatus()
            }
        case "reply":
            if let url = event["url"] as? String, !url.isEmpty {
                showPairing(event)
            } else if event["sessions"] != nil {
                model.sessions = event["sessions"] as? Int ?? 0
                model.phones = event["links"] as? Int ?? 0
                model.devices = event["devices"] as? Int ?? 0
                if event["pairing"] is NSNull { clearPairing() }
            }
        default:
            return
        }
        render()
    }

    private func showPairing(_ event: [String: Any]) {
        guard let url = event["url"] as? String, let expiresAt = event["expiresAt"] as? Double else { return }
        model.pairingURL = url
        model.pairingExpires = Date(timeIntervalSince1970: expiresAt / 1000)
        showWindow()
        let delay = max(1, expiresAt / 1000 - Date().timeIntervalSince1970)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            if self?.model.pairingURL == url { self?.clearPairing() }
        }
    }

    private func clearPairing() {
        model.pairingURL = nil
        model.pairingExpires = nil
    }

    private var relayHost: String? {
        guard let relay = readJSON(supportDir.appendingPathComponent("agent.json"))?["relayUrl"] as? String else { return nil }
        return URLComponents(string: relay)?.host
    }

    private func render() {
        let symbol: String
        let text: String
        if paused {
            (symbol, text) = ("pause.circle", "已暂停：手机暂时连不上这台 Mac")
        } else {
            switch link {
            case "connected": (symbol, text) = ("terminal", "已连接，可以在手机上使用")
            case "starting", "connecting", "restarting": (symbol, text) = ("ellipsis.circle", "正在连接中转服务器…")
            case "unconfigured": (symbol, text) = ("exclamationmark.triangle", "还没有连接中转服务器")
            case "failed": (symbol, text) = ("exclamationmark.triangle", "无法启动 agent，请检查 node 路径")
            default: (symbol, text) = ("wifi.exclamationmark", "未连接，正在重试…")
            }
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: text)
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "RemoteTerm：\(text)"
        statusLine.title = text
        countsLine.title = "\(model.sessions) 个会话 · \(model.phones) 个手机连接"
        countsLine.isHidden = link != "connected" || paused
        pairItem.isEnabled = link == "connected" && !paused
        pauseItem.title = paused ? "恢复" : "暂停"
        let loginEnabled = SMAppService.mainApp.status == .enabled
        loginItem.state = loginEnabled ? .on : .off

        model.symbol = symbol
        model.headline = text
        model.paused = paused
        model.connected = link == "connected" && !paused
        model.loginItem = loginEnabled
        model.fullDiskAccess = hasFullDiskAccess()
        model.detail = configured
            ? "中转服务器：\(relayHost ?? "?")。会话在这台 Mac 上运行；暂停或退出 RemoteTerm 会结束所有会话。"
            : "在项目目录运行 node agent/setup.js wss://<中转域名>/agent，把打印的哈希填进服务器的 .env，然后重新打开 RemoteTerm。"
    }

    // TCC.db is readable only with Full Disk Access, so reading it is the usual yes/no check.
    private func hasFullDiskAccess() -> Bool {
        FileManager.default.isReadableFile(atPath: "/Library/Application Support/com.apple.TCC/TCC.db")
    }

    // MARK: actions

    @objc private func showWindow() {
        if window == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: StatusView(model: model)))
            window.title = "RemoteTerm"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.delegate = self
            self.window = window
        }
        askStatus()
        render()
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.askStatus()
            self?.render()
        }
        if window?.isVisible != true { window?.center() }
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        window?.makeKeyAndOrderFront(nil)
    }

    @objc private func pair() {
        ask("pair")
    }

    // Sessions live in the agent process: stopping it ends them. Ask first when any are running.
    private func confirmEndingSessions(_ action: String) -> Bool {
        guard model.sessions > 0 else { return true }
        let alert = NSAlert()
        alert.messageText = "\(action)会结束 \(model.sessions) 个会话"
        alert.informativeText = "会话里正在运行的程序会收到挂断信号并退出。"
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "取消")
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc private func togglePause() {
        if !paused && !confirmEndingSessions("暂停") { return }
        paused.toggle()
        if paused {
            agent.stop()
            link = "paused"
            clearPairing()
        } else {
            restartDelay = 1
            startAgent()
        }
        render()
    }

    @objc private func toggleLoginItem() {
        setLoginItem(SMAppService.mainApp.status != .enabled)
    }

    private func setLoginItem(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSAlert(error: error).runModal()
        }
        render()
    }

    private func openFullDiskAccess() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openLogs() {
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logDir)
    }

    @objc private func quit() {
        if !confirmEndingSessions("退出") { return }
        paused = true
        agent.stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { NSApp.terminate(nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
