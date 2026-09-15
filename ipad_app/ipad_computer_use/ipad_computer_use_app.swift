import SwiftUI
import ReplayKit

@main struct IPadComputerUseApp: App {
    init() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--relay-url"), args.indices.contains(index + 1) {
            UserDefaults.standard.set(args[index + 1], forKey: "relayAddress")
        }
    }
    var body: some Scene { WindowGroup { RelayView() } }
}

struct RelayView: View {
    @AppStorage("relayAddress") private var address = ""
    @AppStorage("onboardingCompleted") private var onboardingCompleted = false
    @State private var onboardingStep = 0
    @State private var draftServer = ""
    @State private var calibrationRequested = false
    @State private var setup = SetupStatus()
    @State private var currentID: String? = try? SharedConfiguration.load().sessionID
    @State private var editingServer = false
    @State private var broadcastLauncher = BroadcastLauncher()
    @State private var showNativePicker = false
    @State private var calibrating = false
    @State private var working = false
    @State private var ending = false
    @State private var message: String?
    @State private var activityNote: String?
    @State private var refreshID = 0
    @State private var launchRequest = SessionLaunchRequest.shared
    @Environment(\.scenePhase) private var phase

    private var active: Bool { currentID != nil && setup.sessionID == currentID && setup.serverConnected }
    private var title: String {
        if ending { return "Ending session" }
        if !setup.hasCheckedServer && setup.isChecking { return "Checking connections" }
        guard currentID != nil else { return "No active session" }
        if !setup.serverReachable { return "Connection interrupted" }
        if setup.sessionState == "starting" { return "Waiting for screen sharing" }
        if !active { return "Session disconnected" }
        if setup.inputReady != true { return "Input tool disconnected" }
        if setup.calibrating { return "Calibrating" }
        if setup.calibrated != true { return "Calibration needed" }
        return setup.sendingInput ? "Sending input" : "Ready"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if !onboardingCompleted {
                        onboarding
                    } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Image(systemName: active ? "cursorarrow.motionlines" : "ipad")
                            .font(.system(size: 36)).foregroundStyle(.teal).accessibilityHidden(true)
                        Text(title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                    }.padding(.top, 24)
                    VStack(spacing: 0) {
                        readiness("Input Tool", icon: "cable.connector", value: setup.inputReady == nil ? "Not checked" : setup.inputDetail, ready: setup.inputReady == true, checking: setup.checkingInput)
                        Divider()
                        readiness("Control Server", icon: "network", value: setup.serverReachable ? (active ? "Connected" : "Available") : (setup.hasCheckedServer ? setup.serverDetail : "Not checked"), ready: setup.serverReachable, checking: setup.checkingServer)
                        DisclosureGroup("Edit Control Server", isExpanded: $editingServer) {
                            VStack(alignment: .leading, spacing: 12) {
                                TextField("ws://server-address:8765/device", text: $draftServer)
                                    .textFieldStyle(.roundedBorder).keyboardType(.URL)
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .accessibilityLabel("Control server URL")
                                Button(currentID == nil ? "Save and Connect" : "End Session and Save") {
                                    Task { await saveServer() }
                                }.buttonStyle(.bordered).disabled(working || draftServer.isEmpty)
                            }.padding(.vertical, 12)
                        }.padding(.bottom, 18)
                        Divider()
                        readiness("Pointer", icon: "scope", value: setup.calibrated == true ? "Calibrated" : (setup.calibrated == nil ? "Not verified" : "Calibration needed"), ready: setup.calibrated == true, checking: setup.checkingPointer)
                        Button(setup.calibrated == true ? "Recalibrate Pointer" : "Calibrate Pointer", systemImage: "scope") {
                            Task {
                                if active { calibrating = true }
                                else {
                                    calibrationRequested = true
                                    if currentID == nil { await startSession() }
                                    else { openBroadcastConfirmation() }
                                }
                            }
                        }.buttonStyle(.bordered).padding(.bottom, 18)
                            .disabled(working || setup.inputReady != true || !setup.serverReachable)
                    }
                    if !setup.serverReachable, let next = setup.nextCheck {
                        HStack {
                            Text("Checking again in")
                            Text(next, style: .relative)
                        }.font(.caption).foregroundStyle(.secondary)
                    }
                    if let message { Text(message).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                    if currentID != nil {
                        if !active && setup.sessionState == "starting" {
                            Button { openBroadcastConfirmation() } label: {
                                Label("Open Broadcast Confirmation", systemImage: "record.circle")
                                    .frame(maxWidth: .infinity, minHeight: 36)
                            }.buttonStyle(.borderedProminent).disabled(working || !setup.serverReachable)
                        }
                        Button(role: .destructive) { Task { await endSession() } } label: {
                            Label("End Session", systemImage: "stop.fill").frame(maxWidth: .infinity, minHeight: 36)
                        }.buttonStyle(.bordered).disabled(working)
                    } else if address.isEmpty {
                        Button { editingServer = true } label: {
                            Label("Connect Control Server", systemImage: "network").frame(maxWidth: .infinity, minHeight: 36)
                        }.buttonStyle(.borderedProminent)
                    } else {
                        Button { Task { await startSession() } } label: {
                            Label("Start Session", systemImage: "play.fill").frame(maxWidth: .infinity, minHeight: 36)
                        }.buttonStyle(.borderedProminent).disabled(working || setup.inputReady != true || !setup.serverReachable)
                    }
                    if let activityNote { Text(activityNote).font(.caption).foregroundStyle(.secondary) }
                    if working { ProgressView().frame(maxWidth: .infinity) }
                    }
                    BroadcastPicker(launcher: broadcastLauncher)
                        .frame(width: 64, height: 64)
                        .opacity(showNativePicker ? 1 : 0)
                        .frame(height: showNativePicker ? 64 : 0).clipped()
                        .allowsHitTesting(showNativePicker)
                        .accessibilityHidden(!showNativePicker)
                }.padding(24).frame(maxWidth: 560).frame(maxWidth: .infinity)
            }
            .navigationTitle("iPad Computer Use").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        setup.retryNow()
                        refreshID += 1
                    } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh connections")
                        .help("Check connections now")
                        .disabled(working)
                }
            }
            .fullScreenCover(isPresented: $calibrating) {
                CalibrationView(address: address, onCompleted: {
                    guard !onboardingCompleted, onboardingStep == 2 else { return }
                    onboardingCompleted = true
                    calibrationRequested = false
                    calibrating = false
                    refreshID += 1
                })
            }
            .onAppear { draftServer = address }
            .task(id: "\(address)|\(phase == .active)|\(refreshID)|\(launchRequest.revision)") {
                guard phase == .active else { return }
                if let error = SharedConfiguration.takeBroadcastError() { message = error }
                setup.retryNow()
                var background = false
                while !Task.isCancelled {
                    await setup.refresh(address: address, checkInput: !calibrating, background: background)
                    background = true
                    guard !Task.isCancelled else { return }
                    if active {
                        showNativePicker = false
                        if calibrationRequested, setup.inputReady == true,
                           onboardingCompleted || (onboardingStep == 2 && setup.inputCompatible) {
                            calibrationRequested = false
                            calibrating = true
                        }
                        if let id = currentID {
                            await SessionActivity.update(id, status: setup.sendingInput ? "Sending input" : "Session active")
                        }
                    }
                    if currentID != nil {
                        activityNote = await SessionActivity.syncPush(address: address, deviceID: SharedConfiguration.localDeviceID())
                    }
                    if let id = currentID, !working, setup.serverReachable,
                       setup.sessionID != id || ["idle", "ended", "stop-unconfirmed"].contains(setup.sessionState) {
                        if setup.sessionState == "stop-unconfirmed" { message = "Session disconnected. Input stop was not confirmed; unplug the input tool if needed." }
                        await SessionActivity.end(id, status: setup.sessionState == "stop-unconfirmed" ? "Input stop unconfirmed" : "Session ended")
                        currentID = nil; ending = false; showNativePicker = false
                        try? SharedConfiguration(address: address).save()
                    }
                    if !working, launchRequest.consume() {
                        await startFromControlCenter()
                    }
                    setup.nextCheck = Date().addingTimeInterval(Double(setup.retryDelay))
                    do { try await Task.sleep(for: .seconds(setup.retryDelay)) } catch { return }
                }
            }
        }
    }

    private var onboarding: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("Step \(onboardingStep + 1) of 3").font(.subheadline).foregroundStyle(.secondary)
            ProgressView(value: Double(onboardingStep + 1), total: 3)
                .accessibilityLabel("Setup progress")
            Text(["Connect your input tool", "Connect your control server", "Calibrate your pointer"][onboardingStep])
                .font(.title2.bold())
            if onboardingStep == 0 {
                Text("Plug the XIAO into your iPad's USB-C port.")
                readiness("Input Tool", icon: "cable.connector", value: setup.inputDetail,
                          ready: setup.inputReady == true, checking: setup.checkingInput)
                if setup.inputReady == true {
                    Label(setup.inputCompatible ? "Input tool responding; USB input ready" : "Input tool status could not be verified. Reconnect and try again.",
                          systemImage: setup.inputCompatible ? "checkmark.shield" : "exclamationmark.triangle")
                        .foregroundStyle(setup.inputCompatible ? Color.green : Color.orange)
                }
                Button("Continue") { message = nil; onboardingStep = 1 }
                    .buttonStyle(.borderedProminent)
                    .disabled(setup.inputReady != true || !setup.inputCompatible || setup.checkingInput)
            } else if onboardingStep == 1 {
                TextField("ws://server-address:8765/device", text: $draftServer)
                    .textFieldStyle(.roundedBorder).keyboardType(.URL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("Control server URL").disabled(working)
                Button("Continue") { Task { await connectOnboardingServer() } }
                    .buttonStyle(.borderedProminent).disabled(working || draftServer.isEmpty)
            } else {
                Text("Keep your iPad in its usual orientation. Approve screen sharing, then leave the pointer untouched while calibration runs.")
                readiness("Input Tool", icon: "cable.connector", value: setup.inputDetail,
                          ready: setup.inputReady == true, checking: setup.checkingInput)
                readiness("Control Server", icon: "network", value: setup.serverDetail,
                          ready: setup.serverReachable, checking: setup.checkingServer)
                Button(currentID == nil ? "Start Calibration" : (active ? "Calibrate Pointer" : "Open Broadcast Confirmation")) {
                    Task {
                        message = nil
                        if active { calibrating = true }
                        else {
                            calibrationRequested = true
                            if currentID == nil { await startSession() }
                            else { openBroadcastConfirmation() }
                        }
                    }
                }.buttonStyle(.borderedProminent)
                    .disabled(working || setup.inputReady != true || !setup.inputCompatible || !setup.serverReachable)
                if calibrationRequested {
                    HStack { ProgressView(); Text("Waiting for screen sharing") }
                }
                if currentID != nil {
                    Button("End Session", role: .destructive) {
                        calibrationRequested = false
                        Task { await endSession() }
                    }.disabled(working)
                }
            }
            if let message { Text(message).foregroundStyle(.red) }
            if working { ProgressView("Connecting...") }
            if onboardingStep > 0 {
                Button("Back", systemImage: "chevron.left") {
                    onboardingStep -= 1; message = nil; calibrationRequested = false
                }.disabled(working)
            }
        }.padding(.top, 24)
    }

    private func connectOnboardingServer() async {
        working = true; message = nil
        defer { working = false }
        let candidate = draftServer.trimmingCharacters(in: .whitespacesAndNewlines)
        let check = SetupStatus()
        await check.refresh(address: candidate, checkInput: false)
        guard check.serverReachable else { message = check.serverDetail; return }
        if currentID != nil, candidate != address {
            working = false
            await endSession()
            working = true
            guard currentID == nil else { return }
        }
        do {
            try SharedConfiguration(address: candidate, sessionID: currentID).save()
            address = candidate
            onboardingStep = 2
            refreshID += 1
        } catch { message = error.localizedDescription }
    }

    private func saveServer() async {
        message = nil
        let candidate = draftServer.trimmingCharacters(in: .whitespacesAndNewlines)
        working = true
        let check = SetupStatus()
        await check.refresh(address: candidate, checkInput: false)
        working = false
        guard check.serverReachable else { message = check.serverDetail; return }
        if currentID != nil {
            await endSession()
            guard currentID == nil else { return }
        }
        do {
            try SharedConfiguration(address: candidate).save()
            address = candidate
            calibrationRequested = false
            editingServer = false
            setup.reset(); refreshID += 1
        } catch { message = error.localizedDescription }
    }

    private func readiness(_ name: String, icon: String, value: String, ready: Bool, checking: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(.secondary).frame(width: 24)
            Text(name).font(.body.weight(.medium))
            Spacer(minLength: 12)
            Text(checking ? "Checking..." : value).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
            Group {
                if checking { ProgressView().controlSize(.small) }
                else {
                    Image(systemName: ready ? "checkmark.circle.fill" : "circle.dashed")
                        .foregroundStyle(ready ? Color.green : Color.secondary)
                }
            }.frame(width: 22, height: 22)
        }.padding(.vertical, 18).accessibilityElement(children: .combine)
    }

    private func startSession() async {
        working = true; message = nil; defer { working = false }
        do {
            guard let id = try await setup.sessionRequest(address: address) else { return }
            currentID = id
            setup.reset()
            setup.sessionID = id; setup.sessionState = "starting"
            try SharedConfiguration(address: address, sessionID: id).save()
            activityNote = await SessionActivity.start(id)
            _ = await SessionActivity.syncPush(address: address, deviceID: SharedConfiguration.localDeviceID())
            openBroadcastConfirmation()
        } catch { message = error.localizedDescription }
    }

    private func startFromControlCenter() async {
        launchRequest.handling = true
        defer { launchRequest.handling = false }
        guard onboardingCompleted else { return }
        guard !active else { return }
        guard !address.isEmpty else {
            editingServer = true
            return
        }
        guard setup.serverReachable, setup.inputReady == true else {
            message = setup.serverReachable ? "Connect the input tool, then tap Start Session." : setup.serverDetail
            return
        }
        if currentID != nil {
            if setup.sessionState == "starting" { openBroadcastConfirmation() }
            return
        }
        await startSession()
    }

    private func endSession() async {
        guard let id = currentID, !working else { return }
        calibrationRequested = false
        working = true; ending = true; message = nil
        defer { working = false; ending = false }
        // A saved session is not proof of a broadcast. Revoke locally first so
        // an unreachable old server cannot trap the user in setup.
        do { try SharedConfiguration.revokeSession() }
        catch {
            message = "Could not clear the saved session: \(error.localizedDescription)"
            return
        }
        var stopConfirmed = false
        do {
            _ = try await setup.sessionRequest(address: address, end: id)
            await setup.refresh(address: address, checkInput: false)
            stopConfirmed = setup.serverReachable && setup.sessionState == "ended"
        } catch { /* Local revocation remains effective while the old server is offline. */ }
        if !stopConfirmed {
            message = "Previous session cleared on this iPad. The old server could not confirm input stopped; unplug and reconnect the input tool if needed."
        }
        await SessionActivity.end(id, status: stopConfirmed ? "Session ended" : "Input stop unconfirmed")
        currentID = nil
        setup.sessionID = nil; setup.sessionState = "idle"
        setup.serverConnected = false; setup.screenBroadcast = false; setup.sendingInput = false
        showNativePicker = false
    }

    private func openBroadcastConfirmation() {
        guard currentID != nil, !active else { return }
        showNativePicker = !broadcastLauncher.present()
        if showNativePicker { message = "Tap the screen-sharing button to open Apple's broadcast confirmation." }
    }
}

@MainActor final class BroadcastLauncher {
    weak var picker: RPSystemBroadcastPickerView?

    func present() -> Bool {
        guard let picker, picker.window != nil else { return false }
        picker.layoutIfNeeded()
        // ReplayKit has no public presentation method. Use the embedded UIKit
        // button, with a visible native-button fallback if its hierarchy changes.
        guard let button = picker.subviews.compactMap({ $0 as? UIButton }).first,
              button.isEnabled else { return false }
        button.sendActions(for: .touchUpInside)
        return true
    }
}

struct BroadcastPicker: UIViewRepresentable {
    let launcher: BroadcastLauncher
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        picker.preferredExtension = Bundle.main.bundleIdentifier.map { $0 + ".broadcast" }
        picker.showsMicrophoneButton = false
        picker.accessibilityLabel = "Start session screen sharing"
        launcher.picker = picker
        return picker
    }
    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
