// Claude 戰情城 — menu bar app.
// Lives in the menu bar showing how many sessions are working / waiting for you,
// drops the war-room city down on click or ⌃⌥C, and keeps the data server running.
import Cocoa
import CoreImage
import WebKit
import Carbon.HIToolbox

let base = URL(string: "http://127.0.0.1:5177/")!
let agentLabel = "tw.rino.claude-warroom"
let amber = NSColor(srgbRed: 1, green: 0.71, blue: 0.28, alpha: 1)
let cyan = NSColor(srgbRed: 0.25, green: 0.88, blue: 1, alpha: 1)

// Borderless panels can't take keyboard focus unless they say so.
final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// MARK: - big alert: a banner sliding down from the top + every screen's edges flashing

final class BannerView: NSView {
    var onClick: (() -> Void)?
    var onClose: (() -> Void)?

    init(frame: NSRect, name: String, text: String, hint: String) {
        super.init(frame: frame)
        wantsLayer = true
        let card = CALayer()
        card.frame = bounds.insetBy(dx: 12, dy: 12) // room for the glow
        card.cornerRadius = 22
        card.backgroundColor = NSColor(srgbRed: 0.03, green: 0.07, blue: 0.12, alpha: 0.96).cgColor
        card.borderWidth = 2
        card.borderColor = cyan.cgColor
        card.shadowColor = cyan.cgColor
        card.shadowOpacity = 0.9
        card.shadowOffset = .zero
        card.shadowRadius = 20
        card.add(pulse("shadowRadius", from: 8, to: 28, duration: 0.8), forKey: "glow")
        layer?.addSublayer(card)

        let center = CGPoint(x: 78, y: bounds.midY)
        for i in 0..<2 { // rings spreading out from the gem
            let ring = CAShapeLayer()
            ring.path = CGPath(ellipseIn: CGRect(x: -26, y: -26, width: 52, height: 52), transform: nil)
            ring.position = center
            ring.fillColor = nil
            ring.strokeColor = cyan.cgColor
            ring.lineWidth = 2
            ring.opacity = 0
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 0.6
            grow.toValue = 1.7
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.9
            fade.toValue = 0
            let group = CAAnimationGroup()
            group.animations = [grow, fade]
            group.duration = 1.4
            group.repeatCount = .infinity
            group.beginTime = CACurrentMediaTime() + Double(i) * 0.7
            ring.add(group, forKey: "ring")
            layer?.addSublayer(ring)
        }
        let gem = CAShapeLayer()
        let shape = CGMutablePath()
        shape.addLines(between: [CGPoint(x: 0, y: 24), CGPoint(x: 16, y: 0), CGPoint(x: 0, y: -24), CGPoint(x: -16, y: 0)])
        shape.closeSubpath()
        gem.path = shape
        gem.position = center
        gem.fillColor = cyan.cgColor
        gem.shadowColor = cyan.cgColor
        gem.shadowOpacity = 1
        gem.shadowOffset = .zero
        gem.shadowRadius = 12
        gem.add(pulse("transform.scale", from: 0.85, to: 1.12, duration: 0.5), forKey: "beat")
        layer?.addSublayer(gem)

        let w = bounds.width
        addSubview(label(name, size: 30, weight: .heavy, color: .white, frame: NSRect(x: 128, y: 82, width: w - 230, height: 40)))
        addSubview(label("做完了・等你回覆", size: 15, weight: .semibold, color: cyan, frame: NSRect(x: 130, y: 60, width: w - 230, height: 22)))
        let body = label(text, size: 13, weight: .regular, color: NSColor(white: 0.78, alpha: 1), frame: NSRect(x: 130, y: 20, width: w - 170, height: 38))
        body.maximumNumberOfLines = 2
        body.lineBreakMode = .byTruncatingTail
        addSubview(body)
        let tip = label(hint, size: 11, weight: .medium, color: NSColor(white: 0.55, alpha: 1), frame: NSRect(x: w - 236, y: 104, width: 160, height: 16))
        tip.alignment = .right
        addSubview(tip)
        let close = NSButton(title: "✕", target: self, action: #selector(closeClicked))
        close.isBordered = false
        close.font = .systemFont(ofSize: 15, weight: .bold)
        close.contentTintColor = NSColor(white: 0.6, alpha: 1)
        close.frame = NSRect(x: w - 64, y: 98, width: 32, height: 28)
        addSubview(close)
    }

    required init?(coder: NSCoder) { fatalError() }

    private func pulse(_ key: String, from: CGFloat, to: CGFloat, duration: Double) -> CABasicAnimation {
        let a = CABasicAnimation(keyPath: key)
        a.fromValue = from
        a.toValue = to
        a.duration = duration
        a.autoreverses = true
        a.repeatCount = .infinity
        return a
    }

    private func label(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, frame: NSRect) -> NSTextField {
        let l = NSTextField(labelWithString: s)
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.frame = frame
        l.lineBreakMode = .byTruncatingTail
        return l
    }

    // the whole card is one big button, except the ✕
    override func hitTest(_ point: NSPoint) -> NSView? {
        let v = super.hitTest(point)
        return v is NSButton ? v : (v == nil ? nil : self)
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) { onClick?() }
    @objc func closeClicked() { onClose?() }
}

final class AlertCenter {
    var onOpen: ((_ key: String?, _ link: String?) -> Void)?
    private var banners: [NSPanel] = []
    private let size = NSSize(width: 760, height: 150)

    // link: opens that session's conversation in the Claude app; without one the click opens the city
    func show(name: String, text: String, key: String?, link: String? = nil) {
        NSSound(named: "Hero")?.play()
        flashEdges()
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isReleasedWhenClosed = false
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let view = BannerView(frame: NSRect(origin: .zero, size: size), name: name, text: text,
                              hint: link != nil ? "點我回到對話 ↗" : "點我打開戰情城 ↗")
        view.onClick = { [weak self, weak panel] in
            if let panel { self?.dismiss(panel) }
            self?.onOpen?(key, link)
        }
        view.onClose = { [weak self, weak panel] in if let panel { self?.dismiss(panel) } }
        panel.contentView = view
        banners.append(panel)

        // start just above the top edge, then drop into place with a little overshoot
        let target = slot(banners.count - 1)
        panel.setFrame(target.offsetBy(dx: 0, dy: size.height + 40), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.55
            ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 1.3, 0.35, 1)
            panel.animator().setFrame(target, display: true)
            panel.animator().alphaValue = 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self, weak panel] in
            if let panel { self?.dismiss(panel) }
        }
    }

    // banners stack downward from the top centre of the screen the mouse is on
    private func slot(_ i: Int) -> NSRect {
        let mouse = NSEvent.mouseLocation
        let vf = (NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main!).visibleFrame
        let w = min(size.width, vf.width - 40)
        return NSRect(x: vf.midX - w / 2, y: vf.maxY - 8 - size.height - CGFloat(i) * (size.height - 8), width: w, height: size.height)
    }

    func dismiss(_ panel: NSPanel) {
        guard let i = banners.firstIndex(of: panel) else { return }
        banners.remove(at: i)
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.35
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
        for (j, p) in banners.enumerated() { p.animator().setFrame(slot(j), display: true) }
    }

    // a cyan frame blinks around every screen, so you notice wherever you're looking
    private func flashEdges() {
        for screen in NSScreen.screens {
            let w = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            w.isOpaque = false
            w.backgroundColor = .clear
            w.hasShadow = false
            w.ignoresMouseEvents = true
            w.isReleasedWhenClosed = false
            w.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            let v = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
            v.wantsLayer = true
            let edge = CAShapeLayer()
            edge.path = CGPath(rect: v.bounds.insetBy(dx: 4, dy: 4), transform: nil)
            edge.fillColor = nil
            edge.strokeColor = cyan.cgColor
            edge.lineWidth = 8
            edge.shadowColor = cyan.cgColor
            edge.shadowOpacity = 1
            edge.shadowOffset = .zero
            edge.shadowRadius = 30
            edge.opacity = 0
            let blink = CAKeyframeAnimation(keyPath: "opacity")
            blink.values = [0, 1, 0.15, 1, 0.15, 1, 0]
            blink.duration = 2.4
            edge.add(blink, forKey: "blink")
            v.layer?.addSublayer(edge)
            w.contentView = v
            w.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { w.orderOut(nil) }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var statusItem: NSStatusItem!
    var panel: Panel!
    var web: WKWebView!
    var server: Process?
    var outsideClick: Any?
    var hotKey: EventHotKeyRef?
    var pinned = false
    var misses = 0
    var phoneOn = false // phones may connect; off until 用手機看 switches it on
    let alerts = AlertCenter()
    var seenTs: Double? // alerts at or before this were already shown
    var ready = false
    var pendingURL: URL? // a claude-warroom:// link that launched us before we were set up

    let home = FileManager.default.homeDirectoryForCurrentUser
    var projectDir: String { Bundle.main.object(forInfoDictionaryKey: "WarRoomProjectDir") as? String ?? "" }
    var agentURL: URL { home.appendingPathComponent("Library/LaunchAgents/\(agentLabel).plist") }
    // visible=0: nobody is looking at a page; client=menubar: we show the alerts, so the server stays quiet
    var stateURL: URL { URL(string: "api/state?visible=0&client=menubar", relativeTo: base)! }

    // listen for links this early, or the one that launched the app is lost
    func applicationWillFinishLaunching(_ note: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(openURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            let icon = NSImage(systemSymbolName: "building.2.fill", accessibilityDescription: "Claude 戰情城")
            icon?.isTemplate = true
            button.image = icon
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(statusClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        buildPanel()
        registerHotKey()
        alerts.onOpen = { [weak self] key, link in
            if let link, let url = URL(string: link) { NSWorkspace.shared.open(url) } else { self?.openBuilding(key) }
        }
        probe { up in if !up { self.startServer() } }
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in self.refresh() }
        refresh()
        ready = true
        if let url = pendingURL { pendingURL = nil; handle(url) }
    }

    // clicking an alert: drop the city down and fly to that building
    func openBuilding(_ key: String?) {
        showPanel()
        guard let key, let json = try? JSONEncoder().encode(key), let arg = String(data: json, encoding: .utf8) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.web.evaluateJavaScript("renderer.focus(\(arg))") }
    }

    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
    }

    // MARK: drop-down panel

    func buildPanel() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: config)
        web.setValue(false, forKey: "drawsBackground") // no white flash before the page paints
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]

        let box = NSView(frame: NSRect(x: 0, y: 0, width: 1180, height: 760))
        box.wantsLayer = true
        box.layer?.cornerRadius = 14
        box.layer?.masksToBounds = true
        box.layer?.backgroundColor = NSColor(srgbRed: 0.02, green: 0.03, blue: 0.06, alpha: 1).cgColor
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor(white: 1, alpha: 0.12).cgColor
        web.frame = box.bounds
        box.addSubview(web)

        panel = Panel(contentRect: box.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.contentView = box
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary] // also over full-screen apps
        panel.hidesOnDeactivate = false
        web.load(URLRequest(url: base))

        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == UInt16(kVK_Escape), self?.panel.isKeyWindow == true { self?.hidePanel(); return nil }
            return e
        }
    }

    // the server may still be starting: keep retrying until the page loads
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { webView.load(URLRequest(url: base)) }
    }

    func togglePanel() { panel.isVisible ? hidePanel() : showPanel() }

    func showPanel() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main!
        let vf = screen.visibleFrame
        let w = min(1180, vf.width - 24), h = min(760, vf.height - 12)
        var x = vf.maxX - w - 12
        if let b = statusItem.button, let win = b.window, win.screen == screen { // centre under the icon
            let r = win.convertToScreen(b.convert(b.bounds, to: nil))
            x = min(max(r.midX - w / 2, vf.minX + 12), vf.maxX - w - 12)
        }
        panel.setFrame(NSRect(x: x, y: vf.maxY - h - 6, width: w, height: h), display: true)
        panel.makeKeyAndOrderFront(nil)
        if outsideClick == nil {
            outsideClick = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                if self?.pinned == false { self?.hidePanel() }
            }
        }
    }

    func hidePanel() {
        panel.orderOut(nil)
        if let m = outsideClick { NSEvent.removeMonitor(m); outsideClick = nil }
    }

    // MARK: menu bar icon

    @objc func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp { showMenu() } else { togglePanel() }
    }

    func showMenu() {
        let menu = NSMenu()
        menu.addItem(item("打開／收起戰情城　⌃⌥C", #selector(menuToggle)))
        menu.addItem(item("用瀏覽器開大視窗", #selector(openInBrowser)))
        menu.addItem(item("用手機看（掃 QR code）", #selector(showPhone)))
        if phoneOn { menu.addItem(item("關閉手機連線", #selector(phoneOff))) }
        menu.addItem(item("重新整理", #selector(reload)))
        menu.addItem(item("預覽提醒", #selector(previewAlert)))
        menu.addItem(.separator())
        let pin = item("釘住（點外面不收起）", #selector(togglePin))
        pin.state = pinned ? .on : .off
        menu.addItem(pin)
        let login = item("登入時自動開啟", #selector(toggleLogin))
        login.state = launchAtLogin ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("結束 Claude 戰情城", #selector(quit)))
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        return i
    }

    @objc func menuToggle() { togglePanel() }
    @objc func openInBrowser() { NSWorkspace.shared.open(URL(string: "http://localhost:5177/")!) }
    @objc func reload() { web.reload() }
    // the preview opens the Claude app's "waiting for you" view, the closest thing to a real session
    @objc func previewAlert() { alerts.show(name: "預覽：某棟大樓", text: "有 session 做完、輪到你時，就會像這樣提醒你。點這張卡會跳到那個對話。", key: nil, link: "claude://code/needs-input") }
    @objc func togglePin() { pinned.toggle() }

    // ---------- phone: QR code of the same-Wi-Fi link (it carries the key from .env) ----------

    var phoneWindow: NSWindow?

    // switch phone access on or off; the reply carries the links for the QR code
    func setPhone(_ on: Bool, _ done: @escaping ([String: Any]?) -> Void) {
        var req = URLRequest(url: URL(string: "api/phone", relativeTo: base)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{\"on\":\(on)}".utf8)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                self.phoneOn = json?["on"] as? Bool ?? self.phoneOn
                done(json)
            }
        }.resume()
    }

    @objc func showPhone() {
        setPhone(true) { json in
            // Tailscale works everywhere (same Wi-Fi or not); plain Wi-Fi is the fallback
            let ts = json?["tsUrl"] as? String
            self.presentPhone(ts ?? json?["url"] as? String, ip: (ts != nil ? json?["ts"] : json?["ip"]) as? String, anywhere: ts != nil)
        }
    }

    @objc func phoneOff() { setPhone(false) { _ in self.phoneWindow?.close() } }

    func presentPhone(_ link: String?, ip: String?, anywhere: Bool) {
        phoneWindow?.close()
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 420), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "用手機看戰情城"
        w.isReleasedWhenClosed = false
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = NSColor(red: 0.02, green: 0.03, blue: 0.06, alpha: 1)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 22, left: 20, bottom: 22, right: 20)
        if let link, let qr = qrImage(link, side: 240) {
            let card = NSView() // white margin around the code so phone cameras find it on the dark window
            card.wantsLayer = true
            card.layer?.backgroundColor = NSColor.white.cgColor
            card.layer?.cornerRadius = 16
            let iv = NSImageView(image: qr)
            iv.imageScaling = .scaleNone
            iv.translatesAutoresizingMaskIntoConstraints = false
            card.addSubview(iv)
            card.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                card.widthAnchor.constraint(equalToConstant: qr.size.width + 28), card.heightAnchor.constraint(equalToConstant: qr.size.height + 28),
                iv.centerXAnchor.constraint(equalTo: card.centerXAnchor), iv.centerYAnchor.constraint(equalTo: card.centerYAnchor),
            ])
            stack.addArrangedSubview(card)
            stack.addArrangedSubview(phoneText("用手機相機掃這個 QR code", 17, .bold, .white))
            let reach = anywhere ? "手機開著 Tailscale，在外面用行動網路也能看（\(ip ?? "")）"
                                 : "手機要和這台 Mac 連同一個 Wi-Fi（\(ip ?? "")）"
            stack.addArrangedSubview(phoneText(reach + "\n打開後按「分享 → 加入主畫面」，就像一個 App\n不用時，右鍵選單可以「關閉手機連線」", 12, .regular, .secondaryLabelColor))
        } else {
            stack.addArrangedSubview(phoneText("📵", 44, .regular, .white))
            stack.addArrangedSubview(phoneText("這台 Mac 現在沒有連上 Wi-Fi", 15, .bold, .white))
            stack.addArrangedSubview(phoneText("連上之後再按一次「用手機看」", 12, .regular, .secondaryLabelColor))
        }
        w.contentView = stack
        w.setContentSize(stack.fittingSize)
        w.center()
        phoneWindow = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    func phoneText(_ s: String, _ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = .systemFont(ofSize: size, weight: weight)
        l.textColor = color
        l.alignment = .center
        return l
    }

    func qrImage(_ text: String, side: CGFloat) -> NSImage? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let out = f.outputImage else { return nil }
        let k = floor(side / out.extent.width)
        let big = out.samplingNearest().transformed(by: CGAffineTransform(scaleX: k, y: k)) // nearest keeps the squares sharp
        let rep = NSCIImageRep(ciImage: big)
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }
    @objc func toggleLogin() { setLaunchAtLogin(!launchAtLogin) }
    @objc func quit() { NSApp.terminate(nil) }

    // ●2 ◆1 next to the icon: working / waiting for you
    func refresh() {
        var req = URLRequest(url: stateURL)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let projects = json?["projects"] as? [[String: Any]]
            DispatchQueue.main.async {
                self.show(projects)
                if let json { self.phoneOn = json["phone"] as? Bool ?? false; self.showNewAlerts(json) }
            }
        }.resume()
    }

    // a session went from working to waiting for you (or alerts were just switched on)
    func showNewAlerts(_ json: [String: Any]) {
        let events = json["events"] as? [[String: Any]] ?? []
        let ts = { (e: [String: Any]) in e["ts"] as? Double ?? 0 }
        guard let seen = seenTs else { // first look: don't replay old alerts
            seenTs = max(json["now"] as? Double ?? 0, events.map(ts).max() ?? 0)
            return
        }
        let fresh = events.filter { ts($0) > seen }
        guard !fresh.isEmpty else { return }
        seenTs = fresh.map(ts).max()
        guard json["alerts"] as? Bool == true else { return } // 🔕 in the dashboard
        for e in fresh.suffix(3) {
            alerts.show(name: e["name"] as? String ?? "", text: e["text"] as? String ?? "", key: e["key"] as? String, link: e["open"] as? String)
        }
    }

    func show(_ projects: [[String: Any]]?) {
        guard let button = statusItem.button else { return }
        guard let projects else {
            button.attributedTitle = NSAttributedString(string: "")
            button.appearsDisabled = true
            misses += 1
            if misses >= 3 { misses = 0; startServer() } // server gone: bring it back
            return
        }
        misses = 0
        button.appearsDisabled = false
        let work = projects.filter { $0["state"] as? String == "work" }.count
        let wait = projects.filter { $0["state"] as? String == "wait" }.count
        let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        let title = NSMutableAttributedString()
        if work > 0 { title.append(NSAttributedString(string: " ●\(work)", attributes: [.font: font, .foregroundColor: amber])) }
        if wait > 0 { title.append(NSAttributedString(string: " ◆\(wait)", attributes: [.font: font, .foregroundColor: cyan])) }
        button.attributedTitle = title
        button.toolTip = "Claude 戰情城：工作中 \(work)・等你回覆 \(wait)"
    }

    // claude-warroom://show | hide | toggle — for Shortcuts, Raycast, Stream Deck…
    @objc func openURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let url = URL(string: event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue ?? "") else { return }
        if ready { handle(url) } else { pendingURL = url }
    }

    func handle(_ url: URL) {
        switch url.host {
        case "show": showPanel()
        case "hide": hidePanel()
        case "test": previewAlert()
        case "phone": showPhone()
        default: togglePanel()
        }
    }

    // MARK: global hotkey ⌃⌥C

    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, ctx in
            let app = Unmanaged<AppDelegate>.fromOpaque(ctx!).takeUnretainedValue()
            DispatchQueue.main.async { app.togglePanel() }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        let id = EventHotKeyID(signature: OSType(0x5752_4D21), id: 1) // 'WRM!'
        RegisterEventHotKey(UInt32(kVK_ANSI_C), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &hotKey)
    }

    // MARK: data server (node server.js), started only if nothing answers on the port

    func probe(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: stateURL)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let up = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(up) }
        }.resume()
    }

    func startServer() {
        if server?.isRunning == true { return }
        guard let node = findNode() else { warnNoNode(); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" // ps, lsof, osascript
        p.environment = env
        let log = home.appendingPathComponent("Library/Logs/ClaudeWarRoom.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: log) {
            h.seekToEndOfFile()
            p.standardOutput = h
            p.standardError = h
        }
        do { try p.run() } catch { NSLog("Claude 戰情城: \(error)"); return }
        server = p
    }

    var warnedNoNode = false

    // without Node.js the city stays empty; say so once instead of failing quietly
    func warnNoNode() {
        NSLog("Claude 戰情城: node not found")
        if warnedNoNode { return }
        warnedNoNode = true
        let a = NSAlert()
        a.messageText = "找不到 Node.js"
        a.informativeText = "戰情城需要 Node.js 才能讀取 Claude Code 的紀錄。\n請到 nodejs.org 下載安裝 LTS 版，裝好後重新打開戰情城。"
        a.addButton(withTitle: "打開 nodejs.org")
        a.addButton(withTitle: "稍後")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(URL(string: "https://nodejs.org")!) }
    }

    func findNode() -> String? {
        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        let p = Process(), pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        p.standardOutput = pipe
        try? p.run()
        p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    // MARK: launch at login (a LaunchAgent that opens this app) — off until you tick it in the menu

    var launchAtLogin: Bool { FileManager.default.fileExists(atPath: agentURL.path) }

    func setLaunchAtLogin(_ on: Bool) {
        guard on else { try? FileManager.default.removeItem(at: agentURL); return }
        let plist: [String: Any] = [
            "Label": agentLabel,
            "ProgramArguments": ["/usr/bin/open", "-a", Bundle.main.bundlePath],
            "RunAtLoad": true,
        ]
        if let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) {
            try? data.write(to: agentURL)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

// quit cleanly on `kill` too, so the server child goes down with us
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { NSApp.terminate(nil) }
sigterm.resume()

app.run()
