// Ambient Glow — paints a dreamy, music-synced glow on the desktop around the Spotify window.
// Receives album colours + beat timeline from the Spicetify extension (ambient-edge.js) on 127.0.0.1:47823.
import AppKit
import Network
import QuartzCore
import CoreImage

// ---------------- shared state ----------------
final class Music {
    var palette: [CGColor] = [
        CGColor(red: 0, green: 0.94, blue: 1, alpha: 1), CGColor(red: 1, green: 0.16, blue: 0.43, alpha: 1),
        CGColor(red: 0.69, green: 0.3, blue: 1, alpha: 1), CGColor(red: 0.98, green: 0.94, blue: 0.01, alpha: 1)]
    var paletteVersion = 0
    var beats: [Double] = [], bars: [Double] = [], segT: [Double] = [], segL: [Double] = []
    var pos = 0.0, posAt = CACurrentMediaTime(), playing = false
    var lastMessage = 0.0                       // when the extension last sent anything
    var currentPos: Double { playing ? pos + (CACurrentMediaTime() - posAt) : pos }
    // if Spotify stops reporting (quit, crashed, theme removed) don't keep "playing" a stale song
    var isPlaying: Bool { playing && CACurrentMediaTime() - lastMessage < 3 }
}
let music = Music()
let lock = NSLock()

func lastIdx(_ a: [Double], _ t: Double) -> Int {
    var lo = 0, hi = a.count - 1, r = -1
    while lo <= hi { let m = (lo + hi) / 2; if a[m] <= t { r = m; lo = m + 1 } else { hi = m - 1 } }
    return r
}

// ---------------- tiny HTTP server ----------------
final class Server {
    let listener: NWListener
    init() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 47823)
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] c in self?.handle(c) }
        listener.start(queue: .global())
    }
    func handle(_ c: NWConnection) {
        c.start(queue: .global())
        var buf = Data()
        let maxRequest = 4 << 20                // 4 MB is far more than a track's analysis needs
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, err in
                if let d = data { buf.append(d) }
                if buf.count > maxRequest { c.cancel(); return }
                if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                    let head = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
                    let lines = head.split(separator: "\r\n")
                    let len = lines.first { $0.lowercased().hasPrefix("content-length:") }
                        .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                    guard len >= 0, len <= maxRequest else { c.cancel(); return }
                    let body = buf[r.upperBound...]
                    if body.count >= len {
                        let parts = (lines.first ?? "").split(separator: " ")
                        if parts.count >= 2, parts[0] == "POST" { self.route(String(parts[1]), Data(body.prefix(len))) }
                        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Private-Network: true\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        c.send(content: Data(resp.utf8), completion: .contentProcessed { _ in c.cancel() })
                        return
                    }
                }
                if done || err != nil { c.cancel(); return }
                read()
            }
        }
        read()
    }
    func route(_ path: String, _ body: Data) {
        guard let j = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return }
        lock.lock(); defer { lock.unlock() }
        music.lastMessage = CACurrentMediaTime()
        if path == "/track" {
            if let p = j["palette"] as? [[Double]], p.count >= 4, p.prefix(4).allSatisfy({ $0.count >= 3 }) {
                music.palette = p.prefix(4).map { CGColor(red: $0[0] / 255, green: $0[1] / 255, blue: $0[2] / 255, alpha: 1) }
                music.paletteVersion += 1
            }
            music.beats = j["beats"] as? [Double] ?? []
            music.bars = j["bars"] as? [Double] ?? []
            music.segT = j["segT"] as? [Double] ?? []
            music.segL = j["segL"] as? [Double] ?? []
        }
        if path == "/track" || path == "/state" {
            if let p = j["pos"] as? Double { music.pos = p; music.posAt = CACurrentMediaTime() }
            if let pl = j["playing"] as? Bool { music.playing = pl }
        }
    }
}

// ---------------- glow window ----------------
let MARGIN: CGFloat = 150          // how far the glow can reach past Spotify's edges (points)

final class GlowView: NSView {
    let container = CALayer(), maskL = CALayer(), conicA = CAGradientLayer(), conicB = CAGradientLayer(), pulse = CALayer()
    var maskSize = CGSize.zero
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer = CALayer()
        layer!.addSublayer(container)
        container.mask = maskL
        for g in [conicA, conicB] {
            g.type = .conic
            g.startPoint = CGPoint(x: 0.5, y: 0.5); g.endPoint = CGPoint(x: 0.5, y: 0)
            container.addSublayer(g)
        }
        conicB.opacity = 0.55
        container.addSublayer(pulse)
        pulse.opacity = 0
    }
    required init?(coder: NSCoder) { fatalError() }

    func setPalette(_ p: [CGColor]) {
        CATransaction.begin(); CATransaction.setAnimationDuration(1.4)
        conicA.colors = [p[0], p[1], p[2], p[3], p[0]]
        conicB.colors = [p[2], p[0], p[3], p[1], p[2]]
        CATransaction.commit()
    }

    // the glow's shape: a soft blurred rounded rect with a hole exactly where Spotify sits,
    // so the glow can only ever appear outside the window, even if the stacking order goes wrong
    func rebuildMask(_ size: CGSize) {
        maskSize = size
        let s: CGFloat = 0.5                                  // render at half res; it's blurred anyway
        let W = Int(size.width * s), H = Int(size.height * s)
        guard W > 0, H > 0, let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        let inner = CGRect(x: MARGIN * s, y: MARGIN * s, width: (size.width - 2 * MARGIN) * s, height: (size.height - 2 * MARGIN) * s)
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.addPath(CGPath(roundedRect: inner.insetBy(dx: -6 * s, dy: -6 * s), cornerWidth: 14 * s, cornerHeight: 14 * s, transform: nil))
        ctx.fillPath()
        guard let img = ctx.makeImage() else { return }
        let ci = CIImage(cgImage: img).clampedToExtent().applyingGaussianBlur(sigma: Double(MARGIN * s) * 0.36).cropped(to: CGRect(x: 0, y: 0, width: W, height: H))
        guard let blurred = CIContext().createCGImage(ci, from: ci.extent),
              let hc = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        hc.draw(blurred, in: CGRect(x: 0, y: 0, width: W, height: H))
        hc.setBlendMode(.clear)
        hc.addPath(CGPath(roundedRect: inner, cornerWidth: 10 * s, cornerHeight: 10 * s, transform: nil))
        hc.fillPath()
        guard let out = hc.makeImage() else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        maskL.frame = CGRect(origin: .zero, size: size)
        maskL.contents = out
        container.frame = CGRect(origin: .zero, size: size)
        pulse.frame = container.bounds
        let d = max(size.width, size.height) * 1.6
        for g in [conicA, conicB] { g.bounds = CGRect(x: 0, y: 0, width: d, height: d); g.position = CGPoint(x: size.width / 2, y: size.height / 2) }
        CATransaction.commit()
    }
}

final class App: NSObject, NSApplicationDelegate {
    var win: NSWindow!, view: GlowView!, server: Server?
    var angle = 0.0, level = 0.3, last = CACurrentMediaTime(), tickN = 0, seenPalette = -1, beatCount = -1, pulseColor = 0
    var lastFrame = CGRect.zero
    var aboveStrikes = 0, lastStrike = 0.0

    func applicationDidFinishLaunching(_ n: Notification) {
        server = try? Server()
        win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: .borderless, backing: .buffered, defer: false)
        win.isOpaque = false; win.backgroundColor = .clear; win.hasShadow = false
        win.ignoresMouseEvents = true
        win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenNone]
        win.level = .normal
        view = GlowView(frame: win.contentView!.bounds)
        view.autoresizingMask = [.width, .height]
        win.contentView = view
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
    }

    var spotifyIdx = -1, myIdx = -1
    func spotifyWindow() -> (CGRect, Int)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        var best: (CGRect, Int)? = nil
        spotifyIdx = -1; myIdx = -1
        for (i, w) in list.enumerated() {
            if (w[kCGWindowNumber as String] as? Int) == win.windowNumber { myIdx = i }
            guard (w[kCGWindowOwnerName as String] as? String) == "Spotify",
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let num = w[kCGWindowNumber as String] as? Int else { continue }
            let r = CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!)
            if r.width < 300 || r.height < 200 { continue }
            if best == nil || r.width * r.height > best!.0.width * best!.0.height { best = (r, num); spotifyIdx = i }
        }
        return best
    }

    func tick() {
        let now = CACurrentMediaTime(); let dt = min(0.1, now - last); last = now
        tickN += 1

        // follow the Spotify window (~20x a second)
        if tickN % 3 == 0 {
            var found = spotifyWindow()
            if let (cg, _) = found {
                // Spotify fills (or nearly fills) its screen → no edge to glow around
                let primaryH = NSScreen.screens.first?.frame.height ?? 0
                let nsRect = CGRect(x: cg.minX, y: primaryH - cg.maxY, width: cg.width, height: cg.height)
                if let scr = NSScreen.screens.first(where: { $0.frame.intersects(nsRect) && $0.frame.contains(CGPoint(x: nsRect.midX, y: nsRect.midY)) }) {
                    let v = scr.visibleFrame
                    if nsRect.width >= v.width - 60 && nsRect.height >= v.height - 60 { found = nil }
                }
            }
            // safety: if macOS stacked us above Spotify, hide rather than cover it
            if found != nil && win.isVisible && myIdx >= 0 && spotifyIdx >= 0 && myIdx < spotifyIdx {
                win.orderOut(nil); found = nil; lastFrame = .zero; aboveStrikes += 1; lastStrike = now
            }
            if now - lastStrike > 30 { aboveStrikes = 0 }   // forgive occasional glitches
            if aboveStrikes > 20 { found = nil }            // keeps landing on top right now → stay hidden for a while
            if let (cg, num) = found {
                let primaryH = NSScreen.screens.first?.frame.height ?? 0
                let f = CGRect(x: cg.minX - MARGIN, y: primaryH - cg.maxY - MARGIN, width: cg.width + 2 * MARGIN, height: cg.height + 2 * MARGIN)
                if f != lastFrame {
                    win.setFrame(f, display: false)
                    if f.size != view.maskSize { view.rebuildMask(f.size) }
                    lastFrame = f
                }
                win.order(.below, relativeTo: num)          // sit directly behind Spotify
            } else if win.isVisible { win.orderOut(nil) }
        }

        guard win.isVisible else { return }      // nothing to draw: skip the animation work

        lock.lock()
        let playing = music.isPlaying, pos = music.currentPos
        let beats = music.beats, bars = music.bars, segT = music.segT, segL = music.segL
        let pv = music.paletteVersion, pal = music.palette
        lock.unlock()
        if pv != seenPalette { seenPalette = pv; view.setPalette(pal) }

        var flash = 0.0, target = 0.1
        if playing {
            let bi = lastIdx(beats, pos)
            if bi >= 0 {
                let since = pos - beats[bi]
                let bri = lastIdx(bars, pos)
                let down = bri >= 0 && abs(bars[bri] - beats[bi]) < 0.05
                flash = exp(-since / (down ? 0.22 : 0.14)) * (down ? 1 : 0.65)
                if bi != beatCount { beatCount = bi; pulseColor = (pulseColor + 1) % 4 }
            }
            let si = lastIdx(segT, pos)
            target = si >= 0 && si < segL.count ? max(0, min(1, (segL[si] + 38) / 34)) : 0.5
            if beats.isEmpty { flash = exp(-(pos.truncatingRemainder(dividingBy: 0.5)) / 0.14) * 0.5 }
        }
        level += (target - level) * min(1, dt / 0.25)

        // dreamy motion: slow drift, nudged forward by beats
        angle += (playing ? 6 + 18 * level + 70 * flash : 3) * dt
        CATransaction.begin(); CATransaction.setDisableActions(true)
        view.conicA.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(angle * .pi / 180)))
        view.conicB.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(-angle * 0.7 * .pi / 180)))
        view.container.opacity = Float(playing ? 0.5 + 0.25 * level + 0.3 * flash : 0.32)
        view.pulse.backgroundColor = pal[pulseColor]
        view.pulse.opacity = Float(flash * 0.45)
        let sc = 1 + 0.025 * flash
        view.container.setAffineTransform(CGAffineTransform(scaleX: CGFloat(sc), y: CGFloat(sc)))
        CATransaction.commit()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)          // no Dock icon, never steals focus
let delegate = App()
app.delegate = delegate
app.run()
