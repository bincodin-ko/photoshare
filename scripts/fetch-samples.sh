#!/usr/bin/env sh
# Download publicly available, real-device Motion Photos and Live Photos used by
# the gated tests in packages/core/test/real-samples.test.ts.
#
# Sources (each file stays under its own project's licence; nothing is vendored here):
#   androidx/media test data (Apache-2.0)  — Pixel 4 XL / Pixel 7 Pro / Galaxy S20 motion photos
#   immich-app/test-assets                  — Galaxy One UI 5/6 motion photos (JPG + HEIC), iPhone 7 HEIC
#   LycheeOrg/Lychee test samples           — iPhone 6s Live Photo pair (train.jpg + train.mov), Pixel motion photo
set -eu
DIR="${1:-$(dirname "$0")/../samples}"
mkdir -p "$DIR"
get() { # url dest
  if [ -s "$DIR/$2" ]; then echo "  have  $2"; return; fi
  echo "  fetch $2"
  curl -fsSL --retry 3 -o "$DIR/$2" "$1" || { echo "  FAILED $2"; rm -f "$DIR/$2"; }
}
M=https://raw.githubusercontent.com/androidx/media/release/libraries/test_data/src/test/assets/media/jpeg
get $M/pixel-motion-photo-2-hevc-tracks.jpg   pixel7pro-motion.jpg
get $M/pixel-motion-photo-shortened.jpg       pixel4xl-motion-shortened.jpg
get $M/ss-motion-photo-shortened.jpg          galaxy-s20-motion-shortened.jpg
I=https://raw.githubusercontent.com/immich-app/test-assets/main/formats
get $I/motionphoto/samsung-one-ui-5.jpg        galaxy-oneui5-motion.jpg
get $I/motionphoto/samsung-one-ui-6.jpg        galaxy-oneui6-motion.jpg
get $I/motionphoto/samsung-one-ui-6.heic       galaxy-oneui6-motion.heic
get $I/heic/IMG_2682.heic                      iphone7-still.heic
L=https://raw.githubusercontent.com/LycheeOrg/Lychee/master/tests/Samples
get $L/train.jpg                               iphone6s-live.jpg
get $L/train.mov                               iphone6s-live.mov
get $L/google_motion_photo.jpg                 pixel-motion.jpg
echo "done → $DIR"
