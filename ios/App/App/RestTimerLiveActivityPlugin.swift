import ActivityKit
import Capacitor
import Foundation

@available(iOS 16.2, *)
@objc(AppLiveActivityPlugin)
public class AppLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLiveActivityPlugin"
    public let jsName = "LiveActivity"

    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isRunning", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentActivity", returnType: CAPPluginReturnPromise),
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["value": ActivityAuthorizationInfo().areActivitiesEnabled])
    }

    @objc func isRunning(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let running = Activity<GenericAttributes>.activities.contains { activity in
            activity.attributes.id == id && activity.activityState == .active
        }
        call.resolve(["value": running])
    }

    @objc func getCurrentActivity(_ call: CAPPluginCall) {
        let requestedId = call.getString("id")
        let activity = Activity<GenericAttributes>.activities.first { activity in
            requestedId == nil || activity.attributes.id == requestedId
        }

        guard let activity else {
            call.resolve()
            return
        }

        call.resolve([
            "id": activity.attributes.id,
            "values": activity.content.state.values,
            "isStale": activity.activityState == .stale,
            "isEnded": activity.activityState == .ended,
            "startedAt": "",
        ])
    }

    @objc func startActivity(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are disabled for this app.")
            return
        }
        guard let id = call.getString("id") else {
            call.reject("Missing activity id")
            return
        }

        let attributes = call.getObject("attributes") as? [String: String] ?? [:]
        let contentState = call.getObject("contentState") as? [String: String] ?? [:]
        let state = GenericAttributes.ContentState(values: contentState)
        let staleDate = restTimerStaleDate(from: contentState)

        Task {
            await endActivities(id: id, dismissalPolicy: .immediate)
            do {
                _ = try Activity.request(
                    attributes: GenericAttributes(id: id, staticValues: attributes),
                    content: ActivityContent(state: state, staleDate: staleDate),
                    pushType: nil
                )
                call.resolve()
            } catch {
                call.reject("Failed to start activity: \(error.localizedDescription)")
            }
        }
    }

    @objc func updateActivity(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing activity id")
            return
        }

        let contentState = call.getObject("contentState") as? [String: String] ?? [:]
        let state = GenericAttributes.ContentState(values: contentState)
        let staleDate = restTimerStaleDate(from: contentState)

        Task {
            for activity in Activity<GenericAttributes>.activities where activity.attributes.id == id {
                await activity.update(ActivityContent(state: state, staleDate: staleDate))
            }
            call.resolve()
        }
    }

    @objc func endActivity(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing activity id")
            return
        }

        let contentState = call.getObject("contentState") as? [String: String] ?? [:]
        let dismissalPolicy = (call.getString("dismissalPolicy") == "immediate") ? ActivityUIDismissalPolicy.immediate : .default

        Task {
            await endActivities(id: id, contentState: contentState, dismissalPolicy: dismissalPolicy)
            call.resolve()
        }
    }

    private func restTimerStaleDate(from contentState: [String: String]) -> Date? {
        guard let endAt = Double(contentState["endAt"] ?? ""), endAt > 0 else { return nil }
        return Date(timeIntervalSince1970: endAt / 1000).addingTimeInterval(60)
    }

    private func endActivities(id: String, contentState: [String: String] = [:], dismissalPolicy: ActivityUIDismissalPolicy) async {
        for activity in Activity<GenericAttributes>.activities where activity.attributes.id == id {
            let finalState = GenericAttributes.ContentState(values: contentState.isEmpty ? activity.content.state.values : contentState)
            await activity.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: dismissalPolicy)
        }
    }
}
