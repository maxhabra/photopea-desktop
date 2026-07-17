import CoreGraphics
import Foundation
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Photopea"
let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
let mine = list.filter { ($0[kCGWindowOwnerName as String] as? String) == owner && (($0[kCGWindowLayer as String] as? Int) ?? 0) == 0 }
print("\(owner) on-screen windows: \(mine.count)")
for w in mine { if let b = w[kCGWindowBounds as String] as? [String:Any] { print("  bounds:", b) } }
exit(mine.count > 0 ? 0 : 1)
