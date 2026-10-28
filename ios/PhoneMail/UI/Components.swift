import SwiftUI
import UIKit

struct PrimaryButton: View {
    let title: String
    var enabled = true
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if busy { ProgressView().tint(Palette.onHeader) } else { Text(title).font(.headline).foregroundStyle(Palette.onHeader) }
            }
            .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.header)
        .clipShape(Capsule())
        .disabled(!enabled || busy)
    }
}

struct ErrorText: View {
    let text: String
    var body: some View {
        if !text.isEmpty {
            Text(text).font(.subheadline).foregroundStyle(Palette.danger).multilineTextAlignment(.center).frame(maxWidth: .infinity)
        }
    }
}

/// An onboarding page: green title, grey subtitle, content, and a footer pinned at the bottom.
struct OnboardingPage<Content: View, Footer: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 14) {
                    Text(title).font(.title2.weight(.semibold)).foregroundStyle(Palette.header).multilineTextAlignment(.center)
                    if let subtitle {
                        Text(subtitle).font(.body).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                    }
                    content
                }
                .padding(.horizontal, 24)
                .padding(.top, 36)
            }
            VStack(spacing: 8) { footer }.padding(.horizontal, 24).padding(.vertical, 16)
        }
        .background(Palette.background)
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// A short confirmation at the bottom of a screen, with Undo when the action can be reversed.
struct Toast: View {
    let text: String
    var undo: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 14) {
            Text(text).font(.subheadline).foregroundStyle(Palette.onToast)
            if let undo {
                Button(L("Undo"), action: undo).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.toastAction)
                    .accessibilityIdentifier("Undo")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Palette.toast.opacity(0.92), in: Capsule())
        .padding(.bottom, 6)
        .transition(.opacity)
    }
}

/// A light haptic tick (swipe-to-reply, sends).
func haptic() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
