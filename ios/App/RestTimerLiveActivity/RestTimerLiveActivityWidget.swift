import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.2, *)
struct RestTimerLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: GenericAttributes.self) { context in
            RestTimerLockScreenView(context: context)
                .activityBackgroundTint(Color(red: 0.08, green: 0.08, blue: 0.08))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(restTimerExerciseName(context))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RestTimerText(endAt: restTimerEndAt(context), isComplete: restTimerIsComplete(context))
                        .font(.title3.monospacedDigit())
                        .fontWeight(.semibold)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            } compactLeading: {
                Image(systemName: "timer")
                    .font(.caption2)
            } compactTrailing: {
                RestTimerText(endAt: restTimerEndAt(context), isComplete: restTimerIsComplete(context))
                    .font(.caption2.monospacedDigit())
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } minimal: {
                Image(systemName: "timer")
            }
        }
    }
}

@available(iOS 16.2, *)
private struct RestTimerLockScreenView: View {
    let context: ActivityViewContext<GenericAttributes>

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "timer")
                .font(.title2)
                .foregroundStyle(Color(red: 0.15, green: 0.39, blue: 0.92))
            VStack(alignment: .leading, spacing: 3) {
                Text(restTimerIsComplete(context) ? "Rest complete" : "Rest timer")
                    .font(.headline)
                Text(restTimerExerciseName(context))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RestTimerText(endAt: restTimerEndAt(context), isComplete: restTimerIsComplete(context))
                .font(.title2.monospacedDigit())
                .fontWeight(.semibold)
                .multilineTextAlignment(.trailing)
                .frame(minWidth: 92, alignment: .trailing)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
    }
}

@available(iOS 16.2, *)
private func restTimerExerciseName(_ context: ActivityViewContext<GenericAttributes>) -> String {
    context.state.values["exerciseName"] ?? "Rest timer"
}

@available(iOS 16.2, *)
private func restTimerEndAt(_ context: ActivityViewContext<GenericAttributes>) -> Date {
    let milliseconds = Double(context.state.values["endAt"] ?? "") ?? 0
    return Date(timeIntervalSince1970: milliseconds / 1000)
}

@available(iOS 16.2, *)
private func restTimerIsComplete(_ context: ActivityViewContext<GenericAttributes>) -> Bool {
    context.state.values["isComplete"] == "true"
}

private struct RestTimerText: View {
    let endAt: Date
    let isComplete: Bool

    var body: some View {
        if isComplete || endAt <= Date() {
            Text("Done")
        } else {
            Text(timerInterval: Date()...endAt, countsDown: true)
        }
    }
}
