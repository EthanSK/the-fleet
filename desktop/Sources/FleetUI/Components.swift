// Building blocks shared by the overview, details, work and settings views.

import SwiftUI
import AppKit
import FleetKit

// MARK: - Faceplate surface

struct Faceplate: ViewModifier {
    var cornerRadius: CGFloat = 14
    var raised = false

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(LinearGradient(colors: [FleetPalette.plateTop, FleetPalette.plateBottom], startPoint: .top, endPoint: .bottom))
                    .overlay(alignment: .top) {
                        // The milled top edge catching light.
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                            .strokeBorder(LinearGradient(colors: [FleetPalette.plateHighlight, .clear], startPoint: .top, endPoint: .center), lineWidth: 1)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(FleetPalette.plateEdge, lineWidth: 1)
                    }
                    .shadow(color: .black.opacity(raised ? 0.16 : 0.07), radius: raised ? 10 : 5, y: raised ? 4 : 2)
            }
    }
}

extension View {
    func faceplate(cornerRadius: CGFloat = 14, raised: Bool = false) -> some View {
        modifier(Faceplate(cornerRadius: cornerRadius, raised: raised))
    }

    /// A recessed slot, like the well holding a device glyph or a meter.
    func recessed(cornerRadius: CGFloat = 8) -> some View {
        background {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(FleetPalette.well)
                .overlay {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(FleetPalette.wellEdge, lineWidth: 1)
                }
        }
    }
}

/// Small uppercase engraved label.
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.eyebrow)
            .tracking(1.1)
            .foregroundStyle(FleetPalette.engraving)
    }
}

// MARK: - Status

struct StatusLamp: View {
    let color: Color
    var size: CGFloat = 9
    var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay(Circle().strokeBorder(.black.opacity(0.12), lineWidth: 0.5))
            .shadow(color: color.opacity(0.75), radius: size * 0.45)
            .opacity(pulsing && dim ? 0.45 : 1)
            .onAppear {
                guard pulsing, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

struct StatusBadge: View {
    let condition: WorkerCondition

    var body: some View {
        HStack(spacing: 6) {
            StatusLamp(color: FleetPalette.color(for: condition), pulsing: condition == .running)
            Text(condition.title.uppercased())
                .font(.eyebrow)
                .tracking(1.1)
                .foregroundStyle(FleetPalette.color(for: condition))
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(condition.title)
    }
}

struct OutcomeBadge: View {
    let outcome: String

    var body: some View {
        let badge = HStack(spacing: 6) {
            StatusLamp(color: FleetPalette.color(forOutcome: outcome), size: 8, pulsing: outcome == "running")
            Text(OutcomeText.title(outcome).uppercased())
                .font(.eyebrow)
                .tracking(1.1)
                .foregroundStyle(FleetPalette.color(forOutcome: outcome))
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(OutcomeText.title(outcome))
        if let help = OutcomeText.help(outcome) { badge.help(help) } else { badge }
    }
}

// MARK: - Signature: one LED per core

/// One LED per CPU core, lit to the one-minute load average, in the worker's status colour.
struct CoreStrip: View {
    let reading: CoreLoad
    let tint: Color
    var height: CGFloat = 12

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: reading.cores > 24 ? 2 : 3) {
                ForEach(0..<reading.cores, id: \.self) { index in
                    let lit = index < reading.lit
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .fill(lit ? tint : FleetPalette.ledOff)
                        .overlay(alignment: .top) {
                            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                                .fill(.white.opacity(lit ? 0.35 : 0.12))
                                .frame(height: height * 0.35)
                                .padding(1)
                        }
                        .shadow(color: lit ? tint.opacity(0.6) : .clear, radius: 3)
                        .frame(maxWidth: 18)
                }
            }
            .frame(height: height)
            if reading.overflow > 0 {
                Text("+\(reading.overflow)")
                    .font(.data(10, weight: .semibold))
                    .foregroundStyle(FleetPalette.hold)
                    .help("\(reading.overflow) more runnable than cores")
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Load \(FleetFormat.load(reading.load)) on \(reading.cores) cores")
    }
}

struct MeterBar: View {
    let fraction: Double
    let tint: Color
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(FleetPalette.well).overlay(Capsule().strokeBorder(FleetPalette.wellEdge, lineWidth: 0.5))
                Capsule().fill(tint).frame(width: max(height, geometry.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

// MARK: - Devices

struct DeviceGlyph: View {
    let kind: DeviceKind
    var size: CGFloat = 52

    var body: some View {
        Image(systemName: kind.symbolName)
            .font(.system(size: size * 0.46, weight: .light))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(.primary)
            .frame(width: size, height: size)
            .recessed(cornerRadius: size * 0.24)
            .accessibilityLabel(kind.title)
    }
}

struct WorkerChip: View {
    let id: String
    var kind: DeviceKind = .mac

    var body: some View {
        Label {
            Text(id).font(.data(11, weight: .medium))
        } icon: {
            Image(systemName: kind.symbolName).font(.system(size: 10))
        }
        .labelStyle(.titleAndIcon)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .recessed(cornerRadius: 6)
        .fixedSize()
    }
}

struct KindChip: View {
    let kind: String

    var body: some View {
        Text(kind.uppercased())
            .font(.system(size: 9, weight: .bold).width(.expanded))
            .tracking(0.8)
            .foregroundStyle(FleetPalette.engraving)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .recessed(cornerRadius: 4)
            .fixedSize()
    }
}

// MARK: - Sections, facts and commands

struct SectionCard<Content: View>: View {
    let title: String
    var trailing: AnyView? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Eyebrow(title)
                Spacer()
                if let trailing { trailing }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .faceplate()
    }
}

struct FactRow: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        GridRow(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(.secondary)
                .gridColumnAlignment(.leading)
            Text(value)
                .font(monospaced ? .data(12) : .body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A copyable command line for guidance. The app never runs these itself.
struct CommandBlock: View {
    let command: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(command)
                .font(.data(12))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
                Task { try? await Task.sleep(nanoseconds: 1_500_000_000); copied = false }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help(copied ? "Copied" : "Copy command")
            .accessibilityLabel("Copy command")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .recessed(cornerRadius: 7)
    }
}

/// An inline notice with a symbol, for problems and advice inside a view.
struct NoticeLine: View {
    let text: String
    var symbol = "exclamationmark.triangle.fill"
    var tint: Color = FleetPalette.hold

    var body: some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol).foregroundStyle(tint)
        }
        .font(.callout)
    }
}

// MARK: - Log console

/// Read-only, selectable monospaced text that follows new output while scrolled to the end.
struct ConsoleTextView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        if let view = scroll.documentView as? NSTextView {
            view.isEditable = false
            view.isSelectable = true
            view.isRichText = false
            view.drawsBackground = false
            view.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
            view.textColor = .labelColor
            view.textContainerInset = NSSize(width: 10, height: 10)
            view.isAutomaticSpellingCorrectionEnabled = false
            view.setAccessibilityLabel("Output")
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView, view.string != text else { return }
        let clip = scroll.contentView
        let atEnd = clip.bounds.maxY >= (view.frame.height - 24)
        let grewFromCurrent = text.hasPrefix(view.string) && !view.string.isEmpty
        if grewFromCurrent {
            view.textStorage?.append(NSAttributedString(string: String(text.dropFirst(view.string.count)), attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular), .foregroundColor: NSColor.labelColor,
            ]))
        } else {
            view.string = text
        }
        if atEnd || !grewFromCurrent { view.scrollToEndOfDocument(nil) }
    }
}

// MARK: - Toolbar

struct RefreshButton: View {
    let store: FleetStore

    var body: some View {
        Button {
            Task { await store.refreshNow() }
        } label: {
            if store.isRefreshing {
                ProgressView().controlSize(.small)
            } else {
                Label("Check now", systemImage: "arrow.clockwise")
            }
        }
        .help("Check every ship now")
        .disabled(store.isRefreshing)
    }
}

// MARK: - Scrolling screens

/// A screen's vertical scroll container. Headless renders set `fleetInlineScroll`
/// to lay content out directly, because ImageRenderer can't draw AppKit-backed
/// scroll views; the app itself always scrolls.
struct FleetScroll<Content: View>: View {
    @Environment(\.fleetInlineScroll) private var inline
    @ViewBuilder var content: Content

    var body: some View {
        if inline {
            content.frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            ScrollView { content }
        }
    }
}

private struct InlineScrollKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var fleetInlineScroll: Bool {
        get { self[InlineScrollKey.self] }
        set { self[InlineScrollKey.self] = newValue }
    }
}
