import Foundation
import Security

struct SharedConfiguration: Codable {
    let address: String
    let deviceID: String?
    let sessionID: String?

    private enum CodingKeys: String, CodingKey {
        case address
        case deviceID
        case sessionID
    }

    init(address: String, sessionID: String? = nil) {
        self.address = address
        self.deviceID = Self.localDeviceID()
        self.sessionID = sessionID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        address = try values.decode(String.self, forKey: .address)
        deviceID = try values.decodeIfPresent(String.self, forKey: .deviceID)
        sessionID = try values.decodeIfPresent(String.self, forKey: .sessionID)
    }

    static func localDeviceID() -> String {
        let key = "calibrationDeviceID"
        if let value = UserDefaults.standard.string(forKey: key), UUID(uuidString: value) != nil { return value }
        let value = UUID().uuidString
        UserDefaults.standard.set(value, forKey: key)
        return value
    }

    private static func query() throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "RelayKeychainGroup") as? String else {
            throw RelayError(message: "Missing shared keychain configuration")
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "KeyRelayConnection", kSecAttrAccount as String: "default",
                kSecAttrAccessGroup as String: group]
    }

    func save() throws {
        guard let url = URL(string: address), ["ws", "wss"].contains(url.scheme),
              url.host != nil, url.path == "/device" else {
            throw RelayError(message: "Enter a valid control server address")
        }
        try persist()
    }

    // Revocation must also work for legacy or invalid saved server addresses.
    static func revokeSession() throws {
        var lookup = try query()
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(lookup as CFDictionary, &value)
        if result == errSecItemNotFound { return }
        guard result == errSecSuccess, let data = value as? Data else {
            throw RelayError(message: "Keychain read failed (\(result))")
        }
        let revoked = try revokingSession(in: data)
        let update = SecItemUpdate(try query() as CFDictionary,
                                  [kSecValueData as String: revoked] as CFDictionary)
        guard update == errSecSuccess else {
            throw RelayError(message: "Keychain update failed (\(update))")
        }
    }

    static func revokingSession(in data: Data) throws -> Data {
        guard var value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RelayError(message: "Invalid saved connection")
        }
        value.removeValue(forKey: "sessionID")
        return try JSONSerialization.data(withJSONObject: value)
    }

    private func persist() throws {
        var query = try Self.query()
        let data = try JSONEncoder().encode(self)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw RelayError(message: "Keychain save failed (\(update))") }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let result = SecItemAdd(query as CFDictionary, nil)
        guard result == errSecSuccess else { throw RelayError(message: "Keychain save failed (\(result))") }
    }

    static func load() throws -> SharedConfiguration {
        var query = try query()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        guard result == errSecSuccess, let data = value as? Data else {
            throw RelayError(message: "Save the broadcast connection in iPad Computer Use first (\(result))")
        }
        return try JSONDecoder().decode(Self.self, from: data)
    }

    static func recordBroadcastError(_ message: String) {
        guard var query = try? query() else { return }
        query[kSecAttrAccount as String] = "last_broadcast_error"
        let data = Data(message.prefix(1500).utf8)
        let result = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if result == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            _ = SecItemAdd(query as CFDictionary, nil)
        }
    }

    static func takeBroadcastError() -> String? {
        guard var query = try? query() else { return nil }
        query[kSecAttrAccount as String] = "last_broadcast_error"
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &value) == errSecSuccess,
              let data = value as? Data else { return nil }
        _ = SecItemDelete(query as CFDictionary)
        return String(data: data, encoding: .utf8)
    }
}
