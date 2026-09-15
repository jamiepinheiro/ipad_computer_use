import ActivityKit
import SwiftUI
import WidgetKit

@main struct ComputerUseWidgets: WidgetBundle {
    var body: some Widget {
        SessionWidget()
        if #available(iOS 18.0, *) { SessionControl() }
    }
}

struct SessionWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SessionActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: "cursorarrow.motionlines").font(.title2).foregroundStyle(.teal)
                VStack(alignment: .leading, spacing: 4) {
                    Text("iPad Computer Use Session").font(.headline)
                    Text(context.isStale ? "Open app for current status" : context.state.status).font(.subheadline)
                }
                Spacer()
                Image(systemName: "arrow.up.forward.app").foregroundStyle(.secondary)
            }.padding().widgetURL(URL(string: "keyrelay://session"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "cursorarrow.motionlines") }
                DynamicIslandExpandedRegion(.center) { Text("iPad Computer Use") }
                DynamicIslandExpandedRegion(.bottom) { Text(context.isStale ? "Open app for current status" : context.state.status) }
            } compactLeading: {
                Image(systemName: "cursorarrow.motionlines")
            } compactTrailing: {
                Image(systemName: context.state.status == "Sending input" ? "keyboard" : "circle")
            } minimal: {
                Image(systemName: "cursorarrow.motionlines")
            }.widgetURL(URL(string: "keyrelay://session"))
        }
    }
}
