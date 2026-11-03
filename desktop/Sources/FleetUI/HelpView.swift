// Getting started, in the app. Commands are shown for copying; the app never runs them.

import SwiftUI

public struct FleetHelpView: View {
    public init() {}

    public var body: some View {
        FleetScroll {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("The Fleet").font(.nameplate(28, weight: .bold))
                    Text("Shares your worker computers between apps and agents. It shows which workers are free, runs saved test and build profiles on them, and keeps a receipt for every run.")
                        .foregroundStyle(.secondary)
                }

                HelpSection(title: "Before You Start") {
                    Text("This Mac needs Node 22.18 or newer, Python 3 and SSH. Workers need Bash, Python 3, tar and the tools their jobs use. Install The Fleet from its source folder:")
                    CommandBlock(command: "npm ci && npm link")
                    Text("To start it at login, install the login service and load it with the command it prints. Otherwise this app or the command line starts it when needed.")
                    CommandBlock(command: "the-fleet service install")
                }

                HelpSection(title: "Pair a Computer") {
                    Text("Agent Bridge keeps each worker's address, user and SSH key. Pair a computer with it first:")
                    CommandBlock(command: "agent-bridge pair")
                    Text("For computers on different networks, sign in to Tailscale on both and set the pairing's internet_host to the worker's Tailscale address. A dedicated worker's owner can turn off its device key expiry in the Tailscale admin console.")
                    Link("Tailscale key expiry", destination: URL(string: "https://tailscale.com/kb/1028/key-expiry")!)
                    Text("Check a new worker's SSH host key through a trusted channel. Never copy private keys into a project.")
                }

                HelpSection(title: "Add a Worker") {
                    Text("Choose Add Worker, then a paired computer. The Fleet checks it first and refuses this Mac or a computer that's already a worker. One physical computer gets one entry; give it aliases instead of a second entry, so they share its job lock.")
                }

                HelpSection(title: "Run a Profile") {
                    Text("A profile is a project's saved test, build or check: the files to send, the command, a time limit and how to tell it passed. Projects register their the-fleet.json:")
                    CommandBlock(command: "the-fleet register the-fleet.json --source /path/to/project")
                    Text("Run one from Projects. It sends files as they are on disk, nothing needs committing, and it keeps running if you quit this app. Cancel it from Work. A run that started never moves to another worker, and nothing falls back to this Mac.")
                }

                HelpSection(title: "Use Your Own SSH") {
                    Text("An agent can reserve a worker and use its own SSH. Others see the reservation until it's released. Expiry keeps ownership, because The Fleet can't tell the work stopped.")
                    CommandBlock(command: "the-fleet reserve --owner my-agent --label \"Focused tests\"")
                    CommandBlock(command: "the-fleet release --id RESERVATION_ID --token RESERVATION_TOKEN")
                }

                HelpSection(title: "What Stays on This Mac") {
                    Text("Tests needing physical devices, a real microphone or camera, live desktop state or real accounts run on the computer that owns them. Workers are other computers; this app never runs jobs itself.")
                }
            }
            .padding(32)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .frame(minWidth: 520, minHeight: 480)
        .textSelection(.enabled)
    }
}

struct HelpSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.nameplate(15))
            content.fixedSize(horizontal: false, vertical: true)
        }
    }
}
