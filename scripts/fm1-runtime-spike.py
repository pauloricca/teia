#!/usr/bin/env python3
"""Build the naked FM-1/Teia spike; no device access, server, or flashing."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod

pin = module("fm1_pins", ROOT / "scripts/fm1-build-spike.py")
def main():
    for repo, expected in ((pin.SOURCE, pin.COMMIT), (pin.SDK, pin.SDK_COMMIT)):
        pin.require(pin.run("git", "-C", str(repo), "rev-parse", "HEAD") == expected, "Wrong upstream revision")
        pin.require(not pin.run("git", "-C", str(repo), "status", "--porcelain", "--untracked-files=no"), "Upstream has tracked changes")
    pin.require(pin.sha(pin.TOOLCHAIN / "pi32v2/bin/clang") == pin.COMPILER_SHA, "Compiler checksum mismatch")
    stage = pin.CACHE / "naked"
    # Own generated build tree only; baseline checkout/results are never changed.
    shutil.rmtree(stage, ignore_errors=True)
    (stage / "firmware/src").mkdir(parents=True)
    (stage / "build/gen").mkdir(parents=True)
    for name in ("hal", "loader"):
        shutil.copytree(pin.SOURCE / "firmware" / name, stage / "firmware" / name)
    for name in ("crt0.S", "app.ld"):
        shutil.copy2(pin.SOURCE / "firmware" / name, stage / "firmware" / name)
    for name in ("libc.c", "lcd.c", "usb.c", "midi_uart.c", "ota.c"):
        shutil.copy2(pin.SOURCE / "firmware/src" / name, stage / "firmware/src" / name)
    shutil.copy2(ROOT / "firmware/fm1/app.c", stage / "firmware/src/felucca.c")
    shutil.copy2(ROOT / "firmware/fm1/runtime.h", stage / "firmware/src/runtime.h")
    shutil.copy2(ROOT / "firmware/fm1/upload.h", stage / "firmware/src/upload.h")
    # Give the device its own visible identity; keep the upstream update-loader identity.
    usb_path = stage / "firmware/src/usb.c"
    usb = usb_path.read_text()
    import re
    def descriptor(name, text):
        data = [2 + 2 * len(text), 3] + [byte for c in text for byte in (ord(c), 0)]
        return f"static const uint8_t {name}[] = {{{','.join(map(str, data))}}};"
    usb = re.sub(r"static const uint8_t STR1\[\] = \{.*?\};", descriptor("STR1", "Teia experiment"), usb, flags=re.S)
    old = "static const uint8_t STR2[] = {16, 3, 'F', 0, 'e', 0, 'l', 0, 'u', 0, 'c', 0, 'c', 0, 'a', 0};"
    pin.require(old in usb, "Upstream USB identity changed")
    usb_path.write_text(usb.replace(old, descriptor("STR2", "Teia FM-1 spike")))
    subprocess.run(["node", str(ROOT / "firmware/fm1/export-patch.mjs"), str(stage / "build/gen")], check=True)
    for name in ("sine", "octave", "tremolo", "subtractive", "phase-fm", "noise", "arithmetic", "highpass", "bandpass", "allpass", "crossover", "hardclip", "saturate", "wavefold", "fold", "abs", "remove-dc", "clamp", "accumulator", "random", "expression-functions", "bend", "feedback-bend"):
        subprocess.run(["node", str(ROOT / "firmware/fm1/export-patch.mjs"), str(stage / "patches" / name), str(ROOT / "firmware/fm1/patches" / (name + ".json"))], check=True)
    # Tiny fixed-cell font: no full Felucca graphics buffers or screens.
    from PIL import Image, ImageDraw, ImageFont, __version__ as pillow
    pin.require(pillow == "12.2.0", "Use spike Python environment (Pillow 12.2.0)")
    font = ImageFont.truetype(str(pin.SOURCE / "assets/fonts/InterTight[wght].ttf"), 10)
    glyphs = []
    for c in range(32, 127):
        image = Image.new("1", (8, 14)); ImageDraw.Draw(image).text((0, 0), chr(c), font=font, fill=1)
        glyphs.append([sum((1 << (7-x)) for x in range(8) if image.getpixel((x,y))) for y in range(14)])
    (stage / "build/gen/font.h").write_text("/* Inter Tight, SIL OFL 1.1; generated 8x14 glyphs. */\nstatic const uint8_t teia_font[95][14] = {" + ",\n".join("{" + ",".join(map(str, g)) + "}" for g in glyphs) + "};\n")
    for key in list(os.environ):
        if key.startswith("FELUCCA_"): del os.environ[key]
    os.environ.update(JIELI_TOOLCHAIN=str(pin.TOOLCHAIN), AC79_SDK=str(pin.SDK), JIELI_DOCKER="1", FELUCCA_SIZE="0")
    sys.path.insert(0, str(pin.SOURCE / "tools"))
    build = module("felucca_builder", pin.SOURCE / "tools/build.py")
    build.SRC = stage; build.FW = stage / "firmware"; build.OUT = stage / "build"
    build.GEN = stage / "build/gen"; build.LDR = stage / "build/loader"
    build.DOCKER_IMAGE = pin.IMAGE; build.PRODUCT = "FM-1_915"
    # Preprocessor identity comes from the shell, not build_app's default flag.
    for rel, expected in build.SDK_SHA256.items():
        pin.require(pin.sha(pin.SDK / "cpu/wl82/tools" / rel) == expected, "SDK file checksum mismatch")
    os.chdir(stage)
    ota = build.build_loader()
    img, syms, dis, rt = build.build_app()
    errors, notes = build.check(img, syms, dis, rt)
    errors += build.mmio_check()
    forbidden = ("dly_buf", "sl_buf", "eng_mem", "SMP_DATA", "mix_block", "seq_tick", "ENGINES", "demo_program")
    for name in forbidden:
        if re.search(r"\s" + re.escape(name) + r"$", syms, re.M): errors.append(f"Unexpected Felucca musical component: {name}")
    for note in notes: print("ok:", note)
    pin.require(not errors, "\n".join(errors))
    package = build.fm1pkg_make.ufw(build.fm1pkg_make.flash_image(img, build.fm1pkg_make.KEY), ota, "FM-1_915")
    out = build.OUT
    (out / "teia-fm1-spike.fwsc").write_bytes(package)
    (out / "symbols.txt").write_text(syms)
    (out / "sections.txt").write_text(build.tc("common/bin/objdump", "-h", out / "felucca.elf"))
    manifest = {
        "status": "compiled; not tested on hardware", "upstream_commit": pin.COMMIT,
        "sdk_commit": pin.SDK_COMMIT, "compiler_sha256": pin.COMPILER_SHA, "image": pin.IMAGE,
        "checks": notes, "forbidden_symbols_absent": list(forbidden),
        "sources": {p.relative_to(ROOT).as_posix(): pin.sha(p) for p in sorted((ROOT / "firmware/fm1").rglob("*")) if p.is_file()},
        "artifacts": {name: {"bytes": (out / name).stat().st_size, "sha256": pin.sha(out / name)} for name in ("felucca.bin", "felucca.elf", "teia-fm1-spike.fwsc", "loader/ota.bin", "gen/program.json", "gen/patch.h")},
    }
    (out / "report.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # Corresponding source and notices accompany the local research build.
    shutil.copytree(pin.SOURCE / "LICENSES", stage / "LICENSES")
    for name in ("LICENSE", "LICENSING.md"):
        shutil.copy2(pin.SOURCE / name, stage / name)
    shutil.copy2(pin.SOURCE / "assets/fonts/OFL.txt", stage / "LICENSES/OFL-InterTight.txt")
    print(f"Firmware ready for bench validation: {out / 'teia-fm1-spike.fwsc'}")

if __name__ == "__main__": main()
