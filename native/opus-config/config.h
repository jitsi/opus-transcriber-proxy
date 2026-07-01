/*
 * Portable libopus build configuration for the native N-API addon.
 *
 * This is a hand-written, platform-agnostic substitute for the config.h that
 * libopus' autotools/cmake build would normally generate. It deliberately
 * enables only the portable C float build and disables every architecture
 * specific optimisation (NEON / SSE / AVX / run-time CPU detection) so that the
 * exact same source list compiles identically on macOS (arm64), Linux x64 and
 * Linux arm64 — including inside the Alpine container. For 24 kHz mono speech
 * the lack of SIMD is irrelevant to throughput.
 *
 * If you ever want SIMD, regenerate a real config.h with libopus' configure for
 * the target platform and add the matching arch source files to binding.gyp.
 */
#ifndef OPUS_NATIVE_CONFIG_H
#define OPUS_NATIVE_CONFIG_H

/* This is a build of OPUS */
#define OPUS_BUILD 1

/* Float build (do NOT define FIXED_POINT). */

/* Use C99 variable-size arrays (clang/gcc support this). */
#define VAR_ARRAYS 1

/* Standard headers available on all our targets (macOS, glibc, musl). */
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_MEMORY_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define STDC_HEADERS 1

/* lrint / lrintf are available in <math.h> on all our targets. */
#define HAVE_LRINT 1
#define HAVE_LRINTF 1

/* Package identification (cosmetic; surfaced by opus_get_version_string()). */
#define PACKAGE_NAME "opus"
#define PACKAGE_TARNAME "opus"
#define PACKAGE_VERSION "1.5.2"
#define PACKAGE_STRING "opus 1.5.2"
#define PACKAGE_BUGREPORT "opus@xiph.org"
#define PACKAGE_URL ""

/* C99 'restrict' keyword. */
#define restrict __restrict

#endif /* OPUS_NATIVE_CONFIG_H */
