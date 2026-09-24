// libwebrtc audio-level harness: links libwebrtc's own modules/audio_processing/rms_level.cc (the RFC 6464 level Chrome
// sends in the ssrc-audio-level extension) so generate.mts can record reference levels for vectors.json.
//
// Build against a WebRTC checkout (no gn/ninja needed; rms_level.cc depends only on headers):
//   W=~/Chromium/WebRTC/src
//   clang++ -std=c++20 -O2 -DNDEBUG -DWEBRTC_POSIX -Wno-nullability-completeness \
//     -I $W -I $W/third_party/abseil-cpp harness.cc $W/modules/audio_processing/rms_level.cc -o webrtc_level
//
// Reads little-endian int16 mono PCM from stdin in packets of `samples_per_packet` samples and prints libwebrtc's
// RFC 6464 level for each packet, the way ChannelSend does it: Analyze() each 10 ms chunk, Average() per packet.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <vector>
#include "modules/audio_processing/rms_level.h"

int main(int argc, char** argv) {
  const size_t samples_per_packet = argc > 1 ? std::atoi(argv[1]) : 480;  // 20 ms at 24 kHz
  const size_t chunk = samples_per_packet / 2;                             // 10 ms chunks
  std::vector<int16_t> buf(samples_per_packet);
  webrtc::RmsLevel rms;
  while (std::fread(buf.data(), sizeof(int16_t), samples_per_packet, stdin) == samples_per_packet) {
    rms.Analyze(std::span<const int16_t>(buf.data(), chunk));
    rms.Analyze(std::span<const int16_t>(buf.data() + chunk, chunk));
    std::printf("%d\n", rms.Average());
  }
  return 0;
}
