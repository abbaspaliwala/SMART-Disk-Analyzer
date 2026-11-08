#!/usr/bin/env bash
#
# Build the Debian package without debhelper: the payload is plain files, so
# dpkg-deb is enough (and this runs happily as an unprivileged user).
#
#   packaging/deb/build-deb.sh            -> build/smart-disk-analyzer_<ver>_all.deb
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PKG="smart-disk-analyzer"
APP_ID="io.github.abbaspaliwala.SmartDiskAnalyzer"

VERSION="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
[ -n "$VERSION" ] || { echo "cannot read the version from package.json" >&2; exit 1; }

BUILD="$ROOT/build"
STAGE="$BUILD/stage"
OUT="$BUILD/${PKG}_${VERSION}_all.deb"

rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN"

install -d "$STAGE/usr/bin" \
           "$STAGE/usr/libexec" \
           "$STAGE/usr/lib/$PKG" \
           "$STAGE/usr/share/applications" \
           "$STAGE/usr/share/metainfo" \
           "$STAGE/usr/share/polkit-1/actions" \
           "$STAGE/usr/share/icons/hicolor/scalable/apps" \
           "$STAGE/usr/share/doc/$PKG"

# --- application payload -----------------------------------------------------
cp -a "$ROOT/server" "$ROOT/shared" "$ROOT/public" "$STAGE/usr/lib/$PKG/"
install -m 0644 "$ROOT/package.json" "$ROOT/README.md" "$STAGE/usr/lib/$PKG/"
install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/lib/$PKG/LICENSE"

# --- desktop integration -----------------------------------------------------
install -m 0755 "$ROOT/packaging/common/smart-disk-analyzer" "$STAGE/usr/bin/$PKG"
install -m 0755 "$ROOT/packaging/common/smart-disk-analyzer-helper" "$STAGE/usr/libexec/$PKG"
install -m 0644 "$ROOT/packaging/common/$APP_ID.policy" \
                "$STAGE/usr/share/polkit-1/actions/$APP_ID.policy"
install -m 0644 "$ROOT/packaging/common/$APP_ID.desktop" \
                "$STAGE/usr/share/applications/$APP_ID.desktop"
install -m 0644 "$ROOT/packaging/common/$APP_ID.metainfo.xml" \
                "$STAGE/usr/share/metainfo/$APP_ID.metainfo.xml"
install -m 0644 "$ROOT/packaging/common/$APP_ID.svg" \
                "$STAGE/usr/share/icons/hicolor/scalable/apps/$APP_ID.svg"

# --- documentation -----------------------------------------------------------
install -m 0644 "$ROOT/LICENSE" "$STAGE/usr/share/doc/$PKG/copyright"
gzip -9 -n -c "$ROOT/README.md" > "$STAGE/usr/share/doc/$PKG/README.gz"
chmod 0644 "$STAGE/usr/share/doc/$PKG/README.gz"

# --- normalise modes (the source tree may be group-writable) -----------------
find "$STAGE/usr" -type d -exec chmod 0755 {} +
find "$STAGE/usr" -type f -exec chmod 0644 {} +
chmod 0755 "$STAGE/usr/bin/$PKG" "$STAGE/usr/libexec/$PKG"

# --- control -----------------------------------------------------------------
INSTALLED_SIZE="$(du -sk --apparent-size "$STAGE/usr" | cut -f1)"
sed -e "s/@VERSION@/$VERSION/" -e "s/@INSTALLED_SIZE@/$INSTALLED_SIZE/" \
    "$HERE/control.in" > "$STAGE/DEBIAN/control"
install -m 0755 "$HERE/postinst" "$STAGE/DEBIAN/postinst"
chmod 0644 "$STAGE/DEBIAN/control"

# --- build -------------------------------------------------------------------
mkdir -p "$BUILD"
dpkg-deb --root-owner-group --build "$STAGE" "$OUT" >/dev/null
echo "built $OUT"
du -h "$OUT" | cut -f1 | sed 's/^/size: /'
