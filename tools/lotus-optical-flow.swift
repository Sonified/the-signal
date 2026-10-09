// macOS Vision flow cache for two animation frames. No UI or network access.
import Foundation
import Vision
import CoreVideo

let args = CommandLine.arguments
guard args.count == 4 else { fatalError("Usage: lotus-optical-flow from.png to.png out.f32") }
let request = VNGenerateOpticalFlowRequest(targetedImageURL: URL(fileURLWithPath: args[2]), options: [:])
request.revision = VNGenerateOpticalFlowRequestRevision2
request.computationAccuracy = .veryHigh
request.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float
let handler = VNImageRequestHandler(url: URL(fileURLWithPath: args[1]), options: [:])
try handler.perform([request])
guard let buffer = request.results?.first?.pixelBuffer else { fatalError("No optical flow result") }
CVPixelBufferLockBaseAddress(buffer, .readOnly)
defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
let stride = CVPixelBufferGetBytesPerRow(buffer), ptr = CVPixelBufferGetBaseAddress(buffer)!
var output = Data()
for y in 0..<height { output.append(ptr.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self), count: width * 8) }
try output.write(to: URL(fileURLWithPath: args[3]))
print("\(width) \(height)")
